// Smoke test for src/main/core/skin.ts and src/main/core/png.ts: the player head next to the
// signed-in name. No Microsoft account needed. The Steve skin is read from the vanilla client jar
// under <root>/minecraft/versions (the root smoke-install prepared, or any launcher root that has
// played once); the skin cache is written to a temporary root and removed at the end. Step 7 hits
// the real skin CDN (textures.minecraft.net) once.
//
//   npx tsx scripts/smoke-head.ts <root>

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { DownloadError } from '../src/main/core/download'
import { resolvePaths } from '../src/main/core/paths'
import { decodePng, encodePng, PngError, pngDataUrl, type Rgba } from '../src/main/core/png'
import {
  activeSkin,
  defaultSkinEntry,
  defaultSkinFor,
  defaultSkinFromJar,
  ensureSkin,
  fallbackHead,
  fallbackHeadDataUrl,
  findClientJar,
  HEAD_SIZE,
  headDataUrl,
  headForProfile,
  headFromSkin,
  isSkinCached,
  javaUuidHashCode,
  readZipEntry,
  SKIN_MAX_PIXELS,
  SkinError,
  skinCachePath,
  type SkinRef,
} from '../src/main/core/skin'

const PROFILE_ID = '069a79f444e94726a5befca90e38aaf5'
/** The dev-client test account: floorMod(hash, 18) = 13, wide makena. */
const DEV_PROFILE_ID = 'd5b4bd6b29833baab494b6a317f345b7'
/** Legacy 64x32 texture on the CDN (the one scripts/smoke-auth.ts answers with), 526 bytes. */
const CDN_HASH = '292009a4925b58f02c77dadc3ecef07ea4c7472f64e0fdc32ce5522489362680'
const STEVE_ENTRY = 'assets/minecraft/textures/entity/player/wide/steve.png'

const logLines: string[] = []
const log = (line: string): void => {
  logLines.push(line)
  console.log('    ' + line)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function pixel(image: Rgba, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!, image.data[at + 3]!]
}

function setPixel(image: Rgba, x: number, y: number, rgba: [number, number, number, number]): void {
  image.data.set(rgba, (y * image.width + x) * 4)
}

function clone(image: Rgba): Rgba {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) }
}

/** One PNG chunk with its CRC, for hand-built hostile files. */
function pngChunk(type: string, body: Uint8Array): Buffer {
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndBody), 0)
  return Buffer.concat([length, typeAndBody, crc])
}

/** A syntactically valid RGBA8 PNG whose IHDR declares width x height and whose IDAT is `idat` as given. */
function hostilePng(width: number, height: number, idat: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ])
}

function fromDataUrl(dataUrl: string): Rgba {
  assert.ok(dataUrl.startsWith('data:image/png;base64,'), 'head must be a PNG data URL')
  return decodePng(Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
}

function assertHead(head: Rgba, what: string): void {
  assert.equal(head.width, HEAD_SIZE, `${what}: width`)
  assert.equal(head.height, HEAD_SIZE, `${what}: height`)
  for (let i = 3; i < head.data.length; i += 4) assert.equal(head.data[i], 255, `${what}: every head texel is opaque`)
  const colours = new Set<string>()
  for (let i = 0; i < head.data.length; i += 4) colours.add(head.data.subarray(i, i + 3).join(','))
  assert.ok(colours.size > 1, `${what}: a face has more than one colour`)
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function step1PureHelpers(): void {
  console.log('1. UUID hash, default skin choice and profile parsing')
  // Vectors checked against java.util.UUID.hashCode() on the Java 21 runtime.
  assert.equal(javaUuidHashCode('069a79f4-44e9-4726-a5be-fca90e38aaf5'), -369792882)
  assert.equal(javaUuidHashCode(PROFILE_ID), -369792882)
  assert.equal(javaUuidHashCode('853c80ef-3c37-49fd-aa49-938b674adae6'), 1946714239)
  assert.equal(javaUuidHashCode('00000000000000000000000000000000'), 0)
  assert.equal(javaUuidHashCode('ffffffffffffffffffffffffffffffff'), 0)
  assert.equal(javaUuidHashCode(DEV_PROFILE_ID), 1599108565)
  assert.throws(() => javaUuidHashCode('not-a-uuid'), (e: unknown) => e instanceof SkinError)
  // DefaultPlayerSkin.get: floorMod(hash, 18), slim 0-8 then wide 9-17, names alphabetical.
  assert.deepEqual(defaultSkinFor(PROFILE_ID), { name: 'alex', model: 'slim' })
  assert.deepEqual(defaultSkinFor('853c80ef-3c37-49fd-aa49-938b674adae6'), { name: 'ari', model: 'slim' })
  assert.deepEqual(defaultSkinFor('00000000000000000000000000000000'), { name: 'alex', model: 'slim' })
  assert.deepEqual(defaultSkinFor(DEV_PROFILE_ID), { name: 'makena', model: 'wide' })
  assert.equal(defaultSkinEntry({ name: 'makena', model: 'wide' }), 'assets/minecraft/textures/entity/player/wide/makena.png')
  log('hashCode vectors and default skin choices match the game')

  const http = `http://textures.minecraft.net/texture/${CDN_HASH}`
  assert.deepEqual(activeSkin([{ state: 'ACTIVE', url: http, variant: 'CLASSIC' }], log), {
    url: `https://textures.minecraft.net/texture/${CDN_HASH}`,
    model: 'wide',
    hash: CDN_HASH,
  })
  assert.equal(activeSkin([{ state: 'ACTIVE', url: http.replace('http:', 'https:'), variant: 'SLIM' }], log)?.model, 'slim')
  assert.equal(
    activeSkin(
      [
        { state: 'INACTIVE', url: 'http://textures.minecraft.net/texture/' + 'a'.repeat(64), variant: 'SLIM' },
        { state: 'ACTIVE', url: http, variant: 'CLASSIC' },
      ],
      log,
    )?.hash,
    CDN_HASH,
    'inactive entries are skipped',
  )
  assert.equal(activeSkin([{ state: 'INACTIVE', url: http, variant: 'CLASSIC' }], log), null)
  assert.equal(activeSkin([], log), null)
  assert.equal(activeSkin(undefined, log), null)
  assert.equal(activeSkin([{ state: 'ACTIVE', url: `https://example.com/texture/${CDN_HASH}`, variant: 'CLASSIC' }], log), null)
  assert.equal(activeSkin([{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/not-hex', variant: 'CLASSIC' }], log), null)
  assert.equal(activeSkin([{ state: 'ACTIVE', url: 'nonsense', variant: 'CLASSIC' }], log), null)
  assert.equal(activeSkin([{ state: 'ACTIVE', variant: 'CLASSIC' }], log), null)
  log('activeSkin: https upgrade, model, inactive skipped, foreign hosts and bad paths rejected')

  const paths = resolvePaths(join('C:', 'root'))
  assert.equal(skinCachePath(paths, PROFILE_ID), join(paths.state, 'skins', `${PROFILE_ID}.png`))
  assert.throws(() => skinCachePath(paths, '../escape'), (e: unknown) => e instanceof SkinError)
  log('cache path is <state>/skins/<profileId>.png and rejects anything that is not a profile id')
}

function step2PngCodec(): void {
  console.log('2. PNG codec round trip and error handling')
  const image: Rgba = {
    width: 3,
    height: 2,
    data: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
    ]),
  }
  const png = encodePng(image)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 3, 'IHDR width')
  assert.equal(png.readUInt32BE(20), 2, 'IHDR height')
  const back = decodePng(png)
  assert.deepEqual(back, image)
  assert.ok(pngDataUrl(png).startsWith('data:image/png;base64,iVBORw0KGgo'))
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), (e: unknown) => e instanceof PngError)
  const corrupt = Buffer.from(png)
  corrupt[20] ^= 0xff
  assert.throws(() => decodePng(corrupt), (e: unknown) => e instanceof PngError && /CRC/.test(e.message))
  assert.throws(() => encodePng({ width: 2, height: 2, data: new Uint8Array(3) }), (e: unknown) => e instanceof PngError)
  log('3x2 RGBA round trip exact, bad signature and bad CRC rejected')

  // Hostile files (the skin comes off the network). An oversized IHDR is refused before the IDAT is even looked
  // at: the IDAT here is not deflate data, so a decoder that reached it would say "corrupt image data" instead.
  const oversized = hostilePng(16384, 16384, Buffer.from('not deflate data'))
  assert.throws(
    () => decodePng(oversized, { maxPixels: SKIN_MAX_PIXELS }),
    (e: unknown) => e instanceof PngError && /16384x16384/.test(e.message) && /at most 4096 pixels/.test(e.message),
    'a 16384x16384 header must be refused by maxPixels with the size and the limit in the message',
  )
  assert.throws(
    () => decodePng(hostilePng(65, 64, Buffer.from('not deflate data')), { maxPixels: SKIN_MAX_PIXELS }),
    (e: unknown) => e instanceof PngError && /65x64/.test(e.message),
    'one pixel over the limit is refused too',
  )
  assert.throws(
    () => decodePng(hostilePng(16385, 1, Buffer.from('not deflate data'))),
    (e: unknown) => e instanceof PngError && /unsupported image size/.test(e.message),
    'the codec keeps its own 16384 side cap without an option',
  )
  assert.equal(decodePng(png, { maxPixels: 6 }).width, 3, 'an image exactly at the limit decodes')
  // A deflate bomb: an 8x8 RGBA image holds (8 * 4 + 1) * 8 = 264 raw bytes, this IDAT inflates to 4 MiB.
  const bomb = hostilePng(8, 8, deflateSync(Buffer.alloc(4 * 1024 * 1024), { level: 9 }))
  assert.ok(bomb.length < 8192, `the bomb file is small (${bomb.length} bytes)`)
  const bombStart = Date.now()
  assert.throws(
    () => decodePng(bomb, { maxPixels: SKIN_MAX_PIXELS }),
    (e: unknown) => e instanceof PngError && /inflates past the 264 bytes/.test(e.message),
    'image data past the declared size is refused, not expanded',
  )
  assert.ok(Date.now() - bombStart < 1000, 'the bomb is refused quickly')
  // The exact bound still accepts every honest file: a 64x64 RGBA image at the skin limit round-trips.
  const full: Rgba = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).map((_, i) => i & 0xff) }
  assert.deepEqual(decodePng(encodePng(full), { maxPixels: SKIN_MAX_PIXELS }), full)
  log('hostile files: 16384x16384 and 65x64 headers refused before any allocation, a 4 MiB deflate bomb refused at the 264 byte bound')

  const fallback = fallbackHead()
  assertHead(fallback, 'fallback face')
  assert.deepEqual(fromDataUrl(fallbackHeadDataUrl()), fallback)
  assert.equal(fallbackHeadDataUrl(), fallbackHeadDataUrl(), 'fallback data URL is stable')
  log(`fallback face: ${HEAD_SIZE}x${HEAD_SIZE}, ${fallbackHeadDataUrl().length} chars as a data URL`)
}

async function step3Steve(jar: string): Promise<Rgba> {
  console.log('3. Steve from the client jar, cropped like the game')
  const bytes = await readZipEntry(jar, STEVE_ENTRY)
  assert.equal(bytes.length, 920, 'wide/steve.png in the 1.21.1 client is 920 bytes')
  await assert.rejects(readZipEntry(jar, 'assets/minecraft/textures/entity/player/wide/nobody.png'), (e: unknown) => e instanceof SkinError)
  const steve = decodePng(bytes)
  assert.equal(steve.width, 64)
  assert.equal(steve.height, 64)
  assert.equal(bytes[25], 3, 'the default skins are palette PNGs (colour type 3), the decoder must handle PLTE and tRNS')
  const head = headFromSkin(steve)
  assertHead(head, 'steve head')
  // The default skins have an empty hat layer, so the head is exactly the face box.
  for (let y = 0; y < HEAD_SIZE; y++) {
    for (let x = 0; x < HEAD_SIZE; x++) {
      const [r, g, b] = pixel(steve, 8 + x, 8 + y)
      assert.deepEqual(pixel(head, x, y), [r, g, b, 255], `head texel ${x},${y} is the face texel`)
      assert.equal(pixel(steve, 40 + x, 8 + y)[3], 0, `steve's hat texel ${x},${y} is transparent`)
    }
  }
  log(`steve: 64x64, palette PNG, head = face box, ${headDataUrl(head).length} chars as a data URL`)

  // Hat layer: cutout at alpha 0.1, opaque texels cover the face.
  const hatted = clone(steve)
  setPixel(hatted, 40, 8, [200, 10, 10, 255])
  setPixel(hatted, 41, 8, [10, 200, 10, 26])
  setPixel(hatted, 42, 8, [10, 10, 200, 25])
  const hatHead = headFromSkin(hatted)
  assert.deepEqual(pixel(hatHead, 0, 0), [200, 10, 10, 255], 'opaque hat texel covers the face')
  assert.deepEqual(pixel(hatHead, 1, 0), [10, 200, 10, 255], 'alpha 26 (0.102) is drawn, opaque like the cutout shader')
  assert.deepEqual(pixel(hatHead, 2, 0), pixel(head, 2, 0), 'alpha 25 (0.098) is discarded')
  // Face alpha is ignored: setNoAlpha on the head box.
  const seeThrough = clone(steve)
  setPixel(seeThrough, 8, 8, [1, 2, 3, 0])
  assert.deepEqual(pixel(headFromSkin(seeThrough), 0, 0), [1, 2, 3, 255], 'a transparent face texel is drawn opaque')
  log('hat cutout threshold and opaque face match HttpTexture and rendertype_entity_cutout_no_cull')

  // Sizes the game discards.
  assert.throws(() => headFromSkin({ width: 128, height: 128, data: new Uint8Array(128 * 128 * 4) }), (e: unknown) => e instanceof SkinError)
  assert.throws(() => headFromSkin({ width: 64, height: 48, data: new Uint8Array(64 * 48 * 4) }), (e: unknown) => e instanceof SkinError)
  log('128x128 and 64x48 skins rejected like the game does')
  return steve
}

function step4Legacy(steve: Rgba): void {
  console.log('4. Legacy 64x32 skins and the Notch transparency hack')
  const legacy: Rgba = { width: 64, height: 32, data: new Uint8Array(steve.data.subarray(0, 64 * 32 * 4)) }
  // A legacy skin whose whole hat region is opaque: the game drops the hat entirely.
  for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) setPixel(legacy, x, y, [9, 9, 9, 255])
  const solid = headFromSkin(legacy)
  assert.deepEqual(pixel(solid, 0, 0), [...pixel(steve, 8, 8).slice(0, 3), 255], 'solid legacy hat region is ignored')
  // One texel with alpha below 128 anywhere in the region keeps the hat.
  setPixel(legacy, 63, 31, [0, 0, 0, 127])
  const kept = headFromSkin(legacy)
  assert.deepEqual(pixel(kept, 0, 0), [9, 9, 9, 255], 'hat drawn once the region has a transparent texel')
  // A 64x64 skin never gets the hack.
  const modern = clone(steve)
  for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) setPixel(modern, x, y, [9, 9, 9, 255])
  assert.deepEqual(pixel(headFromSkin(modern), 0, 0), [9, 9, 9, 255], '64x64 skins keep an all-opaque hat')
  log('legacy hat hack applied to 64x32 only')
}

async function step5Cache(tmpRoot: string, gameRoot: string, jar: string, steve: Rgba): Promise<void> {
  console.log('5. Cache path on Steve, no network')
  const steveBytes = await readZipEntry(jar, STEVE_ENTRY)
  const skin: SkinRef = { url: `https://textures.minecraft.net/texture/${sha256(steveBytes)}`, model: 'wide', hash: sha256(steveBytes) }
  // Skin cache in the temporary root, client jar from the game root.
  const paths = { ...resolvePaths(tmpRoot), minecraft: join(gameRoot, 'minecraft') }
  const expected = headDataUrl(headFromSkin(steve))

  assert.equal(await isSkinCached(paths, PROFILE_ID, skin), false)
  const before = await headForProfile(paths, PROFILE_ID, skin, { network: false, log })
  assert.equal(before.source, 'default-skin', 'without the file and without network the default skin from the jar is shown')
  assert.deepEqual(fromDataUrl(before.dataUrl), headFromSkin(await defaultSkinFromJar(jar, PROFILE_ID)))
  log('missing skin, network off: default skin (slim alex) from the client jar')

  const file = skinCachePath(paths, PROFILE_ID)
  await mkdir(join(paths.state, 'skins'), { recursive: true })
  await writeFile(file, steveBytes)
  assert.equal(await isSkinCached(paths, PROFILE_ID, skin), true)
  const started = Date.now()
  const cached = await headForProfile(paths, PROFILE_ID, skin, { network: false, log })
  const elapsed = Date.now() - started
  assert.equal(cached.source, 'skin')
  assert.equal(cached.dataUrl, expected)
  assert.ok(elapsed < 200, `cached head took ${elapsed} ms`)
  assert.equal((await ensureSkin(paths, PROFILE_ID, skin, { log })).result, 'cached', 'ensureSkin makes no request for a matching file')
  log(`cached skin: head from disk in ${elapsed} ms, ensureSkin says cached`)

  // A changed byte fails the sha256 check: the stale file is not shown, network off falls back.
  const stale = Buffer.from(steveBytes)
  stale[stale.length - 5] ^= 0x01
  await writeFile(file, stale)
  assert.equal(await isSkinCached(paths, PROFILE_ID, skin), false)
  assert.equal((await headForProfile(paths, PROFILE_ID, skin, { network: false, log })).source, 'default-skin')
  log('stale cache file rejected by its sha256')

  // No jar at all (fresh install before the first Play): the bundled face.
  const bare = resolvePaths(join(tmpRoot, 'bare'))
  const fallback = await headForProfile(bare, PROFILE_ID, undefined, { network: false, log })
  assert.equal(fallback.source, 'fallback')
  assert.equal(fallback.dataUrl, fallbackHeadDataUrl())
  assert.equal(await findClientJar(bare), null)
  log('no skin and no client jar: bundled fallback face')

  // An undecodable file that happens to match its hash must not break the chain either.
  const junk = Buffer.from('not a png at all')
  const junkSkin: SkinRef = { url: `https://textures.minecraft.net/texture/${sha256(junk)}`, model: 'wide', hash: sha256(junk) }
  await writeFile(file, junk)
  const junkHead = await headForProfile(paths, PROFILE_ID, junkSkin, { network: false, log })
  assert.equal(junkHead.source, 'default-skin')
  assert.ok(logLines.some((l) => l.includes('could not use the player')), 'the decode failure is logged')
  log('undecodable cached file: logged, default skin shown')
}

async function step6Policy(tmpRoot: string): Promise<void> {
  console.log('6. Download policy still enforced by the downloader')
  const paths = resolvePaths(tmpRoot)
  const foreign: SkinRef = { url: `https://example.com/texture/${CDN_HASH}`, model: 'wide', hash: CDN_HASH }
  await assert.rejects(ensureSkin(paths, PROFILE_ID, foreign, { log }), (e: unknown) => e instanceof DownloadError && e.reason === 'policy')
  const plain: SkinRef = { url: `http://textures.minecraft.net/texture/${CDN_HASH}`, model: 'wide', hash: CDN_HASH }
  await assert.rejects(ensureSkin(paths, PROFILE_ID, plain, { log }), (e: unknown) => e instanceof DownloadError && e.reason === 'policy')
  log('foreign host and plain http rejected with reason policy')
}

async function step7RealCdn(tmpRoot: string): Promise<void> {
  console.log('7. Real download from textures.minecraft.net (legacy 64x32 texture)')
  const paths = resolvePaths(tmpRoot)
  const skin: SkinRef = { url: `https://textures.minecraft.net/texture/${CDN_HASH}`, model: 'wide', hash: CDN_HASH }
  const first = await ensureSkin(paths, DEV_PROFILE_ID, skin, { log, signal: AbortSignal.timeout(30_000) })
  assert.equal(first.result, 'downloaded')
  const bytes = await readFile(first.file)
  assert.equal(bytes.length, 526)
  assert.equal(sha256(bytes), CDN_HASH, 'the URL path segment is the sha256 of the PNG')
  assert.equal(bytes.readUInt32BE(16), 64)
  assert.equal(bytes.readUInt32BE(20), 32)
  const started = Date.now()
  const second = await ensureSkin(paths, DEV_PROFILE_ID, skin, { log })
  assert.equal(second.result, 'cached')
  assert.ok(Date.now() - started < 200, 'second call answers from the disk')
  const head = await headForProfile(paths, DEV_PROFILE_ID, skin, { network: true, log })
  assert.equal(head.source, 'skin')
  assertHead(fromDataUrl(head.dataUrl), 'legacy head')
  log('526-byte legacy skin downloaded, verified, cached, cropped')
}

async function main(): Promise<void> {
  const gameRoot = process.argv[2]
  if (!gameRoot) {
    console.error('usage: npx tsx scripts/smoke-head.ts <root with minecraft/versions/<id>/<id>.jar>')
    process.exit(2)
  }
  const jar = await findClientJar(resolvePaths(gameRoot))
  if (!jar) {
    console.error(`no vanilla client jar under ${join(gameRoot, 'minecraft', 'versions')}; run scripts/smoke-install.ts first`)
    process.exit(2)
  }
  console.log(`client jar: ${jar}`)
  const tmpRoot = await mkdtemp(join(tmpdir(), 'consortium-head-'))
  try {
    step1PureHelpers()
    step2PngCodec()
    const steve = await step3Steve(jar)
    step4Legacy(steve)
    await step5Cache(tmpRoot, gameRoot, jar, steve)
    await step6Policy(tmpRoot)
    await step7RealCdn(tmpRoot)
    console.log('OK: head helpers')
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error('FAILED:', err)
  process.exit(1)
})
