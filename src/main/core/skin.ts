// Player head for the account chip: picks the active skin out of the Minecraft profile reply,
// caches the texture under <state>/skins/ (verified by the sha256 that textures.minecraft.net
// puts in the URL) and crops the 8x8 face with the hat layer on top, following the rules the game
// itself applies (HttpTexture.processLegacySkin and the entity cutout shader). When the account
// has no usable skin the head is the default skin the game would show for that UUID, read from
// the client jar the player already downloaded, or a project-drawn fallback face before the first
// Play. Pure Node, no Electron.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { open as openZip, readEntry, walkEntries } from '@xmcl/unzip'
import { ensureFile, hashFile } from './download'
import type { LauncherPaths } from './paths'
import { decodePng, encodePng, pngDataUrl, type Rgba } from './png'

// ---------------------------------------------------------------------------------------------
// Public types (see docs/CORE_CONTRACT.md, section skin.ts)
// ---------------------------------------------------------------------------------------------

/** Arm model of a skin: CLASSIC (4 px arms) is 'wide', SLIM (3 px arms) is 'slim'. */
export type SkinModel = 'wide' | 'slim'

/** The active skin of a profile, ready for the downloader: https URL on the skin CDN and its sha256. */
export interface SkinRef {
  url: string
  model: SkinModel
  /** sha256 of the PNG bytes, taken from the last path segment of the URL. */
  hash: string
}

export const DEFAULT_SKIN_NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'] as const

/** The game accepts 64x64 and 64x32 skins, so no PNG decoded here may declare more than 64 x 64 pixels. */
export const SKIN_MAX_PIXELS = 64 * 64
export type DefaultSkinName = (typeof DEFAULT_SKIN_NAMES)[number]

export interface DefaultSkin {
  name: DefaultSkinName
  model: SkinModel
}

export interface HeadResult {
  /** The 8x8 head as a data:image/png;base64 URL, ready for an <img>. */
  dataUrl: string
  /** Where the pixels came from: the player's own skin, the game's default skin for this UUID, or the bundled face. */
  source: 'skin' | 'default-skin' | 'fallback'
}

export interface HeadOptions {
  /** True to download a missing or outdated skin; false answers from the disk only. */
  network: boolean
  signal?: AbortSignal
  log?: (line: string) => void
}

export class SkinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkinError'
  }
}

/** The only host the profile reply may point at; anything else is ignored before the downloader sees it. */
export const SKIN_HOST = 'textures.minecraft.net'
/** Texel size of a head face; the skin formats the game accepts are 64x64 and legacy 64x32. */
export const HEAD_SIZE = 8

// ---------------------------------------------------------------------------------------------
// Profile reply -> SkinRef
// ---------------------------------------------------------------------------------------------

interface ProfileSkin {
  state?: string
  url?: string
  variant?: string
}

/**
 * First ACTIVE skin of the profile reply as a SkinRef. The reply carries plain http URLs; the
 * scheme is upgraded to https (the CDN serves both). Null when the account has no skin or the
 * URL is not textures.minecraft.net/texture/<sha256>.
 */
export function activeSkin(skins: ProfileSkin[] | undefined, log: (line: string) => void = console.log): SkinRef | null {
  const active = skins?.find((s) => s.state === 'ACTIVE' && typeof s.url === 'string')
  if (!active?.url) return null
  let url: URL
  try {
    url = new URL(active.url)
  } catch {
    log(`skin: ignoring an unusable skin url: ${active.url}`)
    return null
  }
  const match = /^\/texture\/([0-9a-f]{64})$/i.exec(url.pathname)
  if (url.hostname.toLowerCase() !== SKIN_HOST || !match) {
    log(`skin: ignoring a skin outside ${SKIN_HOST}: ${active.url}`)
    return null
  }
  url.protocol = 'https:'
  return { url: url.href, model: active.variant === 'SLIM' ? 'slim' : 'wide', hash: match[1]!.toLowerCase() }
}

// ---------------------------------------------------------------------------------------------
// Skin cache: <state>/skins/<profileId>.png
// ---------------------------------------------------------------------------------------------

export function skinCachePath(paths: LauncherPaths, profileId: string): string {
  if (!/^[0-9a-f]{32}$/i.test(profileId)) throw new SkinError(`not a Minecraft profile id: ${profileId}`)
  return join(paths.state, 'skins', `${profileId.toLowerCase()}.png`)
}

/** True when the cached skin file exists and its sha256 matches the reference (no network). */
export async function isSkinCached(paths: LauncherPaths, profileId: string, skin: SkinRef): Promise<boolean> {
  const file = skinCachePath(paths, profileId)
  try {
    if (!(await stat(file)).isFile()) return false
    return (await hashFile(file, 'sha256')) === skin.hash
  } catch {
    return false
  }
}

/**
 * Downloads the skin into the cache unless the file there already matches its sha256; a changed
 * skin (new URL, new hash) overwrites the same file, so nothing accumulates. Returns the file path.
 */
export async function ensureSkin(
  paths: LauncherPaths,
  profileId: string,
  skin: SkinRef,
  opts: { signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<{ file: string; result: 'cached' | 'downloaded' }> {
  const file = skinCachePath(paths, profileId)
  const result = await ensureFile({
    url: skin.url,
    dest: file,
    hash: { algorithm: 'sha256', value: skin.hash },
    signal: opts.signal,
    log: opts.log,
  })
  opts.log?.(`skin: ${result} ${file}`)
  return { file, result }
}

// ---------------------------------------------------------------------------------------------
// Head crop
// ---------------------------------------------------------------------------------------------

/**
 * The 8x8 head the game shows for this skin: the face (texels 8..15 x 8..15) with the hat layer
 * (texels 40..47 x 8..15) drawn over it. Same rules as the client:
 * - only 64x64 and legacy 64x32 skins are accepted (HttpTexture.processLegacySkin discards the rest),
 * - the face is made fully opaque (setNoAlpha on the head box),
 * - on a legacy skin a hat region without any transparent pixel means "no hat" (the Notch hack),
 * - the hat layer is a cutout: a texel with alpha below 0.1 is skipped, anything else covers the face.
 */
export function headFromSkin(skin: Rgba): Rgba {
  const { width, height, data } = skin
  if (width !== 64 || (height !== 32 && height !== 64)) {
    throw new SkinError(`skin texture is ${width}x${height}, the game only accepts 64x64 and 64x32`)
  }
  const legacyHatIsSolid = height === 32 && !regionHasTransparency(skin, 32, 0, 64, 32)
  const out = new Uint8Array(HEAD_SIZE * HEAD_SIZE * 4)
  for (let y = 0; y < HEAD_SIZE; y++) {
    for (let x = 0; x < HEAD_SIZE; x++) {
      const at = (y * HEAD_SIZE + x) * 4
      const face = ((8 + y) * width + 8 + x) * 4
      out[at] = data[face]!
      out[at + 1] = data[face + 1]!
      out[at + 2] = data[face + 2]!
      out[at + 3] = 255
      if (legacyHatIsSolid) continue
      const hat = ((8 + y) * width + 40 + x) * 4
      // rendertype_entity_cutout_no_cull.fsh: "if (color.a < 0.1) discard;" and no blending otherwise.
      if (data[hat + 3]! / 255 < 0.1) continue
      out[at] = data[hat]!
      out[at + 1] = data[hat + 1]!
      out[at + 2] = data[hat + 2]!
    }
  }
  return { width: HEAD_SIZE, height: HEAD_SIZE, data: out }
}

/** doNotchTransparencyHack's test: true when at least one texel of [x0, x1) x [y0, y1) has alpha < 128. */
function regionHasTransparency(image: Rgba, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! < 128) return true
    }
  }
  return false
}

export function headDataUrl(head: Rgba): string {
  return pngDataUrl(encodePng(head))
}

// ---------------------------------------------------------------------------------------------
// Bundled fallback face (project-drawn, not a game asset)
// ---------------------------------------------------------------------------------------------

/**
 * A neutral 8x8 face in the launcher's own palette: a grey face under a gold hard hat. Drawn for
 * this project so that no Mojang texture ships inside the launcher (README, "Game files and mods").
 * Letters: B background, G gold, D grey, K dark.
 */
const FALLBACK_FACE = [
  'BGGGGGGB',
  'GGGGGGGG',
  'GDDDDDDG',
  'DKKDDKKD',
  'DDDDDDDD',
  'DDKKKKDD',
  'DDDDDDDD',
  'BDDDDDDB',
] as const

const FALLBACK_PALETTE: Record<string, [number, number, number]> = {
  B: [0x1d, 0x23, 0x2c],
  G: [0xd4, 0xa0, 0x17],
  D: [0x8b, 0x95, 0xa5],
  K: [0x0f, 0x12, 0x16],
}

export function fallbackHead(): Rgba {
  const data = new Uint8Array(HEAD_SIZE * HEAD_SIZE * 4)
  FALLBACK_FACE.forEach((row, y) => {
    for (let x = 0; x < HEAD_SIZE; x++) {
      const rgb = FALLBACK_PALETTE[row[x]!]
      if (!rgb) throw new SkinError(`fallback face uses an unknown letter ${row[x]}`)
      data.set([rgb[0], rgb[1], rgb[2], 255], (y * HEAD_SIZE + x) * 4)
    }
  })
  return { width: HEAD_SIZE, height: HEAD_SIZE, data }
}

let cachedFallbackDataUrl: string | undefined

export function fallbackHeadDataUrl(): string {
  cachedFallbackDataUrl ??= headDataUrl(fallbackHead())
  return cachedFallbackDataUrl
}

// ---------------------------------------------------------------------------------------------
// The game's default skin for a UUID (DefaultPlayerSkin, 1.21.1)
// ---------------------------------------------------------------------------------------------

/** java.util.UUID.hashCode(): Long.hashCode(most ^ least) = (int)(v ^ (v >>> 32)). Dashes optional. */
export function javaUuidHashCode(id: string): number {
  const hex = id.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new SkinError(`not a Minecraft profile id: ${id}`)
  const most = BigInt('0x' + hex.slice(0, 16))
  const least = BigInt('0x' + hex.slice(16))
  const xor = most ^ least
  return Number(BigInt.asIntN(32, xor ^ (xor >> 32n)))
}

/**
 * net.minecraft.client.resources.DefaultPlayerSkin.get(uuid) in 1.21.1: DEFAULT_SKINS[floorMod(hash, 18)]
 * where indices 0-8 are the slim alex..zuri and 9-17 the wide alex..zuri, both alphabetical.
 */
export function defaultSkinFor(id: string): DefaultSkin {
  const index = ((javaUuidHashCode(id) % 18) + 18) % 18
  return { name: DEFAULT_SKIN_NAMES[index % 9]!, model: index < 9 ? 'slim' : 'wide' }
}

/** Path of a default skin inside the vanilla client jar. */
export function defaultSkinEntry(skin: DefaultSkin): string {
  return `assets/minecraft/textures/entity/player/${skin.model}/${skin.name}.png`
}

/** yauzl's Entry, taken from the walker's signature so this module does not import yauzl itself. */
type ZipEntry = Parameters<Parameters<typeof walkEntries>[1]>[0]

/** Reads one entry of a zip (jar) file into memory. Throws SkinError when the entry is missing. */
export async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const zip = await openZip(zipPath, { lazyEntries: true, autoClose: false })
  try {
    let found: ZipEntry | undefined
    await walkEntries(zip, (entry) => {
      if (entry.fileName !== entryName) return false
      found = entry
      return true
    })
    if (!found) throw new SkinError(`${entryName} is not in ${zipPath}`)
    return await readEntry(zip, found)
  } finally {
    zip.close()
  }
}

/**
 * The vanilla client jar under <paths.minecraft>/versions/<id>/<id>.jar, or null before the first
 * Play. Only vanilla versions have a jar (NeoForge's folder holds a json), the newest one wins.
 */
export async function findClientJar(paths: LauncherPaths): Promise<string | null> {
  const versions = join(paths.minecraft, 'versions')
  let ids: string[]
  try {
    ids = await readdir(versions)
  } catch {
    return null
  }
  let best: { path: string; mtimeMs: number } | null = null
  for (const id of ids) {
    const jar = join(versions, id, `${id}.jar`)
    try {
      const info = await stat(jar)
      if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) best = { path: jar, mtimeMs: info.mtimeMs }
    } catch {
      // Not a vanilla version folder.
    }
  }
  return best?.path ?? null
}

/** The default skin the game shows for this UUID, decoded from the player's own copy of the client jar. */
export async function defaultSkinFromJar(jarPath: string, profileId: string): Promise<Rgba> {
  return decodePng(await readZipEntry(jarPath, defaultSkinEntry(defaultSkinFor(profileId))), { maxPixels: SKIN_MAX_PIXELS })
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

/**
 * The head to show for a profile. Never throws: every failure is logged and the next source is
 * tried, down to the bundled face. With network=false the player's skin is used only when the
 * cache already holds it; with network=true a missing or outdated skin is downloaded first.
 */
export async function headForProfile(
  paths: LauncherPaths,
  profileId: string,
  skin: SkinRef | undefined,
  opts: HeadOptions,
): Promise<HeadResult> {
  const log = opts.log ?? console.log
  if (skin) {
    try {
      let ready = await isSkinCached(paths, profileId, skin)
      if (!ready && opts.network) {
        await ensureSkin(paths, profileId, skin, { signal: opts.signal, log })
        ready = true
      }
      if (ready) {
        const png = await readFile(skinCachePath(paths, profileId))
        return { dataUrl: headDataUrl(headFromSkin(decodePng(png, { maxPixels: SKIN_MAX_PIXELS }))), source: 'skin' }
      }
    } catch (err) {
      log(`skin: could not use the player's skin, showing the default head instead: ${describe(err)}`)
    }
  }
  try {
    const jar = await findClientJar(paths)
    if (jar) {
      return { dataUrl: headDataUrl(headFromSkin(await defaultSkinFromJar(jar, profileId))), source: 'default-skin' }
    }
  } catch (err) {
    log(`skin: could not read the default skin from the client jar: ${describe(err)}`)
  }
  return { dataUrl: fallbackHeadDataUrl(), source: 'fallback' }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
