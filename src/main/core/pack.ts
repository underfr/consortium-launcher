// packwiz 1.1.0 consumer: keeps <instance> in sync with the pack served at a base URL.
// Only files recorded in the previous state file are ever deleted; saves, screenshots
// and player settings live in the same instance directory and must survive every sync.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parse as parseToml, TomlError, type TomlTableWithoutBigInt, type TomlValueWithoutBigInt } from 'smol-toml'
import type { LauncherJson, OptionRules, PackInfo, PackOption, PackSide, ProgressReporter, SyncResult } from '../../shared/types'
import type { LauncherPaths } from './paths'
import { ensureFile, fetchBytes, fetchJson, hashBytes, runWithConcurrency, type HashAlgorithm } from './download'

export interface SyncOptions {
  paths: LauncherPaths
  instanceId: string
  /** Must end with '/'. pack.toml lives at baseUrl + 'pack.toml'. */
  baseUrl: string
  side: 'client' | 'server'
  report: ProgressReporter
  /**
   * Decides which optional entries to install, given the pack's option list (fresh from the
   * metafiles on a full pass, from the state cache on the short-circuit path). Return a record
   * keyed by metafile path; a missing key means option.default. Wins over enabledOptions.
   */
  resolveOptions?: (options: PackOption[]) => Record<string, boolean>
  /** Precomputed choices keyed by metafile path (e.g. "mods/foo.pw.toml"); the trivial resolver. */
  enabledOptions?: Record<string, boolean>
  signal?: AbortSignal
  log?: (line: string) => void
}

export class PackError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PackError'
  }
}

/** Parallel downloads / metafile fetches. */
const CONCURRENCY = 6
/** raw.githubusercontent.com caches for a few minutes; one short retry covers a push in progress. */
const STALE_RETRY_MS = 5000
/** pack.toml, index.toml and metafiles must never come from a cache. */
const NO_STORE: RequestInit = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }

// ---------------------------------------------------------------------------
// Parsed pack structures
// ---------------------------------------------------------------------------

interface PackToml {
  name: string
  version: string
  index: { file: string; hashFormat: HashAlgorithm; hash: string }
  versions: { minecraft: string; neoforge: string }
}

interface IndexEntry {
  file: string
  hash: string
  hashFormat: HashAlgorithm
  metafile: boolean
  preserve: boolean
}

interface Metafile {
  name: string
  filename: string
  side: PackSide
  download: { url: string; hashFormat: HashAlgorithm; hash: string }
  option?: { optional: boolean; default: boolean; description?: string }
}

/** One file the instance must contain after the sync. */
interface PlannedFile {
  /** posix path relative to the instance directory. */
  relPath: string
  url: string
  hash: string
  hashFormat: HashAlgorithm
  optional: boolean
  preserve: boolean
  /** The index entry this file comes from (the .pw.toml path for metafiles). */
  source: string
  /** Player-facing name for progress messages. */
  label: string
}

interface StateFileEntry {
  hash: string
  hashFormat: HashAlgorithm
  optional: boolean
  preserved: boolean
  source: string
}

/** <paths.state>/sync-<instanceId>.json. Small and human-readable on purpose. */
interface StateFile {
  packHash: string
  indexHash: string
  /** enabledOptions used for this sync, so toggling an optional mod invalidates the short-circuit. */
  options: Record<string, boolean>
  /**
   * Optional entries of this side seen in the last full pass. Exact for indexHash: any edit to a
   * metafile's [option] block changes that metafile's hash in index.toml and therefore the index hash.
   */
  optionList: PackOption[]
  /** Index entries skipped for this side or disabled, so the short-circuit can prove the state is complete. */
  skipped: string[]
  files: Record<string, StateFileEntry>
}

/** A state written by a launcher before 0.3.0 has no option list: it still drives delete-on-vanish, never the short-circuit. */
type PreviousState = Omit<StateFile, 'optionList'> & { optionList: PackOption[] | null }

// ---------------------------------------------------------------------------
// TOML helpers (smol-toml returns loosely typed tables; validate every field we rely on)
// ---------------------------------------------------------------------------

type Table = TomlTableWithoutBigInt

function parseTomlText(text: string, what: string): Table {
  try {
    // The option is explicit so the overload without bigint is picked (packwiz never needs bigints).
    return parseToml(text, { integersAsBigInt: false })
  } catch (err) {
    const detail = err instanceof TomlError ? err.message.split('\n')[0] : String(err)
    throw new PackError(`${what} is not valid TOML (${detail})`, err)
  }
}

function tableOf(value: TomlValueWithoutBigInt | undefined, what: string): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) {
    throw new PackError(`${what} is missing or malformed`)
  }
  return value
}

function requireString(table: Table, key: string, what: string): string {
  const value = table[key]
  if (typeof value !== 'string' || value === '') throw new PackError(`${what} is missing the "${key}" field`)
  return value
}

function optionalString(table: Table, key: string, what: string): string | undefined {
  const value = table[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new PackError(`${what} has a "${key}" field that is not text`)
  return value
}

function optionalBool(table: Table, key: string, what: string): boolean | undefined {
  const value = table[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new PackError(`${what} has a "${key}" field that is not true/false`)
  return value
}

function hashFormatOf(value: string, what: string): HashAlgorithm {
  switch (value) {
    case 'sha1':
    case 'sha256':
    case 'sha512':
    case 'md5':
      return value
    default:
      throw new PackError(`${what} uses the hash format "${value}", which this launcher does not support`)
  }
}

function isPackSide(value: string): value is PackSide {
  return value === 'both' || value === 'client' || value === 'server'
}

function parsePackToml(text: string, url: string): PackToml {
  const what = `The pack description (${url})`
  const t = parseTomlText(text, what)
  const format = requireString(t, 'pack-format', what)
  const major = format.startsWith('packwiz:') ? format.slice('packwiz:'.length).split('.')[0] : undefined
  if (major !== '1') {
    throw new PackError(`${what} uses the format "${format}", but this launcher only understands packwiz 1.x packs`)
  }
  const index = tableOf(t['index'], `${what} [index] section`)
  const versions = tableOf(t['versions'], `${what} [versions] section`)
  return {
    name: requireString(t, 'name', what),
    version: optionalString(t, 'version', what) ?? '',
    index: {
      file: requireString(index, 'file', `${what} [index] section`),
      hashFormat: hashFormatOf(requireString(index, 'hash-format', `${what} [index] section`), `${what} index`),
      hash: requireString(index, 'hash', `${what} [index] section`).toLowerCase(),
    },
    versions: {
      minecraft: requireString(versions, 'minecraft', `${what} [versions] section`),
      neoforge: requireString(versions, 'neoforge', `${what} [versions] section`),
    },
  }
}

function parseIndexToml(text: string, url: string): IndexEntry[] {
  const what = `The pack index (${url})`
  const t = parseTomlText(text, what)
  const defaultFormat = optionalString(t, 'hash-format', what)
  const files = t['files'] ?? []
  if (!Array.isArray(files)) throw new PackError(`${what} has a malformed [[files]] list`)
  return files.map((raw, i) => {
    const entryWhat = `${what} entry #${i + 1}`
    const entry = tableOf(raw, entryWhat)
    const file = requireString(entry, 'file', entryWhat)
    const format = optionalString(entry, 'hash-format', entryWhat) ?? defaultFormat
    if (format === undefined) throw new PackError(`${what} does not say which hash format "${file}" uses`)
    return {
      file,
      hash: requireString(entry, 'hash', `${what} entry "${file}"`).toLowerCase(),
      hashFormat: hashFormatOf(format, `${what} entry "${file}"`),
      metafile: optionalBool(entry, 'metafile', entryWhat) ?? false,
      preserve: optionalBool(entry, 'preserve', entryWhat) ?? false,
    }
  })
}

function parseMetafile(text: string, entryFile: string): Metafile {
  const what = `The mod file "${entryFile}"`
  const t = parseTomlText(text, what)
  const name = optionalString(t, 'name', what) ?? posix.basename(entryFile, '.pw.toml')
  const side = optionalString(t, 'side', what) ?? 'both'
  if (!isPackSide(side)) {
    throw new PackError(`${what} has an unknown side "${side}" (expected both, client or server)`)
  }
  const download = tableOf(t['download'], `${what} [download] section`)
  const mode = optionalString(download, 'mode', `${what} [download] section`) ?? 'url'
  const url = optionalString(download, 'url', `${what} [download] section`)
  if (mode !== 'url' || url === undefined) {
    throw new PackError(
      `${name} (${entryFile}) is distributed through "${mode}", which this launcher does not support. ` +
        'Ask the pack maintainer to host it on Modrinth or as a direct download.',
    )
  }
  const optionTable = t['option']
  const option =
    optionTable === undefined
      ? undefined
      : (() => {
          const o = tableOf(optionTable, `${what} [option] section`)
          const description = optionalString(o, 'description', `${what} [option] section`)?.trim()
          return {
            optional: optionalBool(o, 'optional', `${what} [option] section`) ?? false,
            default: optionalBool(o, 'default', `${what} [option] section`) ?? false,
            ...(description ? { description } : {}),
          }
        })()
  return {
    name,
    filename: requireString(t, 'filename', what),
    side,
    download: {
      url,
      hashFormat: hashFormatOf(requireString(download, 'hash-format', `${what} [download] section`), `${what} download`),
      hash: requireString(download, 'hash', `${what} [download] section`).toLowerCase(),
    },
    option,
  }
}

// ---------------------------------------------------------------------------
// Paths and URLs
// ---------------------------------------------------------------------------

/** Normalizes a pack-relative path and refuses anything that could escape the instance directory. */
function safeRelPath(raw: string, what: string): string {
  const normalized = posix.normalize(raw.replace(/\\/g, '/'))
  const escapes =
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('/') ||
    normalized.startsWith('../') ||
    /^[a-zA-Z]:/.test(normalized)
  if (escapes) throw new PackError(`${what} points outside the game folder ("${raw}"), refusing to touch it`)
  return normalized
}

function instanceFile(instanceDir: string, relPath: string): string {
  return join(instanceDir, ...relPath.split('/'))
}

/** Resolves a pack-relative file against the directory that holds index.toml, escaping each segment. */
function packFileUrl(indexDirUrl: string, relPath: string): string {
  return new URL(relPath.split('/').map(encodeURIComponent).join('/'), indexDirUrl).href
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

// ---------------------------------------------------------------------------
// Remote reads
// ---------------------------------------------------------------------------

interface RemotePack {
  pack: PackToml
  /** sha256 of pack.toml exactly as served; the short-circuit key. */
  packHash: string
  indexHash: string
  indexUrl: string
  /** Directory URL (ends with '/') that every [[files]] path is relative to. */
  indexDirUrl: string
  entries: IndexEntry[]
}

function assertBaseUrl(baseUrl: string): void {
  if (!baseUrl.endsWith('/')) throw new PackError(`The pack address must end with a slash: ${baseUrl}`)
}

/**
 * Fetches pack.toml and its index, verifying the index against pack.index.hash. When they
 * disagree (a push landed between the two CDN caches) both are fetched again once after a pause.
 */
async function fetchRemotePack(baseUrl: string, signal: AbortSignal | undefined, log: (line: string) => void): Promise<RemotePack> {
  assertBaseUrl(baseUrl)
  const packUrl = new URL('pack.toml', baseUrl).href
  for (let attempt = 0; ; attempt++) {
    const packBytes = await fetchBytes(packUrl, { ...NO_STORE, signal })
    const pack = parsePackToml(decodeUtf8(packBytes), packUrl)
    const indexUrl = new URL(pack.index.file, packUrl).href
    const indexBytes = await fetchBytes(indexUrl, { ...NO_STORE, signal })
    const indexHash = hashBytes(indexBytes, pack.index.hashFormat)
    if (indexHash === pack.index.hash) {
      return {
        pack,
        packHash: hashBytes(packBytes, 'sha256'),
        indexHash,
        indexUrl,
        indexDirUrl: new URL('.', indexUrl).href,
        entries: parseIndexToml(decodeUtf8(indexBytes), indexUrl),
      }
    }
    if (attempt === 0) {
      log(`index hash ${indexHash} does not match pack.toml (${pack.index.hash}), retrying in ${STALE_RETRY_MS / 1000} s`)
      await sleep(STALE_RETRY_MS, undefined, { signal })
      continue
    }
    throw new PackError(
      `The modpack index (${indexUrl}) does not match its pack description. ` +
        'The pack is probably being updated right now, please try again in a few minutes.',
    )
  }
}

/** Fetches a metafile and checks it against the index entry, with the same stale-cache retry. */
async function fetchMetafile(
  entry: IndexEntry,
  indexDirUrl: string,
  signal: AbortSignal | undefined,
  log: (line: string) => void,
): Promise<Metafile> {
  const url = packFileUrl(indexDirUrl, entry.file)
  for (let attempt = 0; ; attempt++) {
    const bytes = await fetchBytes(url, { ...NO_STORE, signal })
    if (hashBytes(bytes, entry.hashFormat) === entry.hash) return parseMetafile(decodeUtf8(bytes), entry.file)
    if (attempt === 0) {
      log(`${entry.file} does not match the index hash yet, retrying in ${STALE_RETRY_MS / 1000} s`)
      await sleep(STALE_RETRY_MS, undefined, { signal })
      continue
    }
    throw new PackError(
      `The mod file ${entry.file} (${url}) does not match the checksum listed in the modpack index. ` +
        'The pack is probably being updated right now, please try again in a few minutes.',
    )
  }
}

/** Every metafile of the index, keyed by its path. */
async function fetchMetafiles(remote: RemotePack, signal: AbortSignal | undefined, log: (line: string) => void): Promise<Map<string, Metafile>> {
  const metaEntries = remote.entries.filter((e) => e.metafile)
  const metaResults = await runWithConcurrency(
    metaEntries.map((entry) => () => fetchMetafile(entry, remote.indexDirUrl, signal, log)),
    CONCURRENCY,
  )
  return new Map(metaEntries.map((entry, i) => [entry.file, metaResults[i]]))
}

/** The optional entries this side can install, in index order (the order the UI lists them in). */
function optionsOf(remote: RemotePack, metafiles: Map<string, Metafile>, side: 'client' | 'server'): PackOption[] {
  const options: PackOption[] = []
  for (const entry of remote.entries) {
    if (!entry.metafile) continue
    const meta = metafiles.get(entry.file)
    if (!meta?.option?.optional) continue
    if (meta.side !== 'both' && meta.side !== side) continue
    options.push({
      file: entry.file,
      name: meta.name,
      ...(meta.option.description ? { description: meta.option.description } : {}),
      default: meta.option.default,
      side: meta.side,
    })
  }
  return options
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

function statePathFor(paths: LauncherPaths, instanceId: string): string {
  return join(paths.state, `sync-${instanceId}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPackOption(value: unknown): value is PackOption {
  return (
    isRecord(value) &&
    typeof value['file'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['default'] === 'boolean' &&
    typeof value['side'] === 'string' &&
    isPackSide(value['side']) &&
    (value['description'] === undefined || typeof value['description'] === 'string')
  )
}

/** Returns null when there is no usable state (first run, or a damaged file: treated as a fresh sync). */
async function loadState(path: string, log: (line: string) => void): Promise<PreviousState | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    const raw: unknown = JSON.parse(text)
    if (!isRecord(raw) || typeof raw['packHash'] !== 'string' || typeof raw['indexHash'] !== 'string' || !isRecord(raw['files'])) {
      throw new Error('missing packHash, indexHash or files')
    }
    const files: Record<string, StateFileEntry> = {}
    for (const [relPath, value] of Object.entries(raw['files'])) {
      if (!isRecord(value) || typeof value['hash'] !== 'string' || typeof value['hashFormat'] !== 'string') {
        throw new Error(`malformed entry for ${relPath}`)
      }
      files[relPath] = {
        hash: value['hash'],
        hashFormat: hashFormatOf(value['hashFormat'], `The sync state entry "${relPath}"`),
        optional: value['optional'] === true,
        preserved: value['preserved'] === true,
        source: typeof value['source'] === 'string' ? value['source'] : relPath,
      }
    }
    const options: Record<string, boolean> = {}
    if (isRecord(raw['options'])) {
      for (const [key, value] of Object.entries(raw['options'])) if (typeof value === 'boolean') options[key] = value
    }
    const skipped = Array.isArray(raw['skipped']) ? raw['skipped'].filter((v): v is string => typeof v === 'string') : []
    // No list (state written by a launcher before 0.3.0) or a malformed one: the next sync does a full pass.
    let optionList: PackOption[] | null = null
    if (Array.isArray(raw['optionList']) && raw['optionList'].every(isPackOption)) {
      optionList = raw['optionList'].map((o) => ({
        file: o.file,
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        default: o.default,
        side: o.side,
      }))
    } else {
      log(`sync state ${path} has no usable option list, the next sync reads every metafile`)
    }
    return { packHash: raw['packHash'], indexHash: raw['indexHash'], options, optionList, skipped, files }
  } catch (err) {
    log(`ignoring damaged sync state ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function saveState(path: string, state: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

function sameOptions(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  return keysA.length === keysB.length && keysA.every((k, i) => k === keysB[i] && a[k] === b[k])
}

/**
 * The short-circuit is only safe when the state and the index describe the same set of entries
 * (every index entry is an installed file or a deliberate skip, every recorded file comes from
 * the index) and every recorded file is still on disk.
 */
function stateCoversIndex(state: PreviousState, remote: RemotePack, instanceDir: string): boolean {
  const entries = new Set(remote.entries.map((e) => e.file))
  const sources = new Set(Object.values(state.files).map((f) => f.source))
  const skipped = new Set(state.skipped)
  if (!remote.entries.every((e) => sources.has(e.file) || skipped.has(e.file))) return false
  if (![...sources].every((source) => entries.has(source))) return false
  return Object.keys(state.files).every((relPath) => existsSync(instanceFile(instanceDir, relPath)))
}

// ---------------------------------------------------------------------------
// syncPack
// ---------------------------------------------------------------------------

function packInfo(remote: RemotePack, files: number): PackInfo {
  return {
    name: remote.pack.name,
    version: remote.pack.version,
    minecraft: remote.pack.versions.minecraft,
    neoforge: remote.pack.versions.neoforge,
    files,
  }
}

/** Turns index entries (plus their fetched metafiles) into the list of files this side needs. */
function planFiles(
  remote: RemotePack,
  metafiles: Map<string, Metafile>,
  side: 'client' | 'server',
  enabledOptions: Record<string, boolean>,
  log: (line: string) => void,
): { planned: PlannedFile[]; skipped: string[] } {
  const planned: PlannedFile[] = []
  const skipped: string[] = []
  const seen = new Map<string, string>()

  for (const entry of remote.entries) {
    let file: PlannedFile
    if (entry.metafile) {
      const meta = metafiles.get(entry.file)
      if (!meta) throw new PackError(`Internal error: no metafile loaded for ${entry.file}`)
      if (meta.side !== 'both' && meta.side !== side) {
        log(`skip ${entry.file}: ${meta.side} side only`)
        skipped.push(entry.file)
        continue
      }
      if (meta.option?.optional) {
        const enabled = enabledOptions[entry.file] ?? meta.option.default
        if (!enabled) {
          log(`skip ${entry.file}: optional and not enabled`)
          skipped.push(entry.file)
          continue
        }
      }
      file = {
        relPath: safeRelPath(posix.join(posix.dirname(entry.file), meta.filename), `The mod ${meta.name}`),
        url: meta.download.url,
        hash: meta.download.hash,
        hashFormat: meta.download.hashFormat,
        optional: meta.option?.optional ?? false,
        preserve: entry.preserve,
        source: entry.file,
        label: meta.name,
      }
    } else {
      const relPath = safeRelPath(entry.file, 'A pack file')
      file = {
        relPath,
        url: packFileUrl(remote.indexDirUrl, entry.file),
        hash: entry.hash,
        hashFormat: entry.hashFormat,
        optional: false,
        preserve: entry.preserve,
        source: entry.file,
        label: posix.basename(relPath),
      }
    }
    const previous = seen.get(file.relPath)
    if (previous !== undefined) {
      throw new PackError(`The modpack lists ${file.relPath} twice (from ${previous} and ${entry.file}). Ask the pack maintainer to fix the pack.`)
    }
    seen.set(file.relPath, entry.file)
    planned.push(file)
  }
  return { planned, skipped }
}

/**
 * Brings <instance> in line with the pack. Cheap when nothing changed: two small fetches, a hash
 * comparison and presence checks. Otherwise every file is verified by hash (and downloaded when
 * missing or different), files that left the pack are removed, and the state file is rewritten.
 *
 * Optional entries: the resolver runs on the option list of the pack (cached in the state on the
 * short-circuit path, fresh from the metafiles on a full pass). A changed answer fails the
 * short-circuit, so a newly disabled entry is skipped and its file removed by delete-on-vanish,
 * and a newly enabled one is downloaded.
 */
export async function syncPack(o: SyncOptions): Promise<SyncResult> {
  const log = o.log ?? console.log
  const fixed = o.enabledOptions ?? {}
  const resolve = o.resolveOptions ?? ((): Record<string, boolean> => fixed)
  const instanceDir = o.paths.instance(o.instanceId)
  const statePath = statePathFor(o.paths, o.instanceId)

  o.report({ phase: 'pack', message: 'Checking the modpack' })
  const remote = await fetchRemotePack(o.baseUrl, o.signal, log)
  await mkdir(instanceDir, { recursive: true })
  const previous = await loadState(statePath, log)

  if (
    previous &&
    previous.optionList !== null &&
    previous.packHash === remote.packHash &&
    previous.indexHash === remote.indexHash &&
    sameOptions(previous.options, resolve(previous.optionList))
  ) {
    if (stateCoversIndex(previous, remote, instanceDir)) {
      const count = Object.keys(previous.files).length
      log(`pack unchanged (${count} files present)`)
      o.report({ phase: 'pack', message: 'Modpack is up to date', current: count, total: count, unit: 'files' })
      return { pack: packInfo(remote, count), downloaded: 0, deleted: 0, skipped: count, unchanged: true, options: previous.optionList }
    }
    log('pack unchanged but some files are missing, verifying everything')
  }

  // Full pass: read every metafile, then verify or download every file.
  o.report({ phase: 'pack', message: 'Reading the modpack index' })
  const metafiles = await fetchMetafiles(remote, o.signal, log)
  const optionList = optionsOf(remote, metafiles, o.side)
  const enabledOptions = resolve(optionList)
  const { planned, skipped: skippedEntries } = planFiles(remote, metafiles, o.side, enabledOptions, log)

  const total = planned.length
  const files: Record<string, StateFileEntry> = {}
  let downloaded = 0
  let upToDate = 0
  let done = 0
  o.report({ phase: 'pack', message: 'Checking modpack files', current: 0, total, unit: 'files' })

  await runWithConcurrency(
    planned.map((file) => async () => {
      const dest = instanceFile(instanceDir, file.relPath)
      let preserved = false
      if (file.preserve && existsSync(dest)) {
        // preserve = the player may have edited it; never overwrite once present.
        preserved = true
        upToDate++
      } else {
        o.report({ phase: 'pack', message: `Checking ${file.label}`, current: done, total, unit: 'files' })
        const result = await ensureFile({
          url: file.url,
          dest,
          hash: { algorithm: file.hashFormat, value: file.hash },
          signal: o.signal,
          log,
        })
        if (result === 'downloaded') {
          downloaded++
          log(`downloaded ${file.relPath}`)
        } else {
          upToDate++
        }
      }
      done++
      files[file.relPath] = { hash: file.hash, hashFormat: file.hashFormat, optional: file.optional, preserved, source: file.source }
      o.report({ phase: 'pack', message: `${file.label} is ready`, current: done, total, unit: 'files' })
    }),
    CONCURRENCY,
  )

  // Delete-on-vanish: only files we installed earlier (recorded in the previous state).
  let deleted = 0
  if (previous) {
    for (const relPath of Object.keys(previous.files)) {
      if (relPath in files) continue
      let safe: string
      try {
        safe = safeRelPath(relPath, 'A previously synced file')
      } catch (err) {
        log(err instanceof Error ? err.message : String(err))
        continue
      }
      const target = instanceFile(instanceDir, safe)
      const info = await stat(target).catch(() => null)
      if (!info?.isFile()) continue
      o.report({ phase: 'pack', message: `Removing ${posix.basename(safe)}`, current: done, total, unit: 'files' })
      await rm(target, { force: true })
      deleted++
      log(`removed ${safe} (left the pack or turned off)`)
    }
  }

  await saveState(statePath, {
    packHash: remote.packHash,
    indexHash: remote.indexHash,
    options: enabledOptions,
    optionList,
    skipped: skippedEntries,
    files,
  })

  log(`pack synced: ${downloaded} downloaded, ${upToDate} up to date, ${deleted} removed, ${skippedEntries.length} entries skipped`)
  o.report({ phase: 'pack', message: 'Modpack is up to date', current: total, total, unit: 'files' })
  return { pack: packInfo(remote, total), downloaded, deleted, skipped: upToDate, unchanged: false, options: optionList }
}

/**
 * The option list for the UI, before or between syncs: the list cached by the last full pass when
 * a state exists (no network), else pack.toml + index + every metafile. Never touches the instance
 * or the state; the next Play refreshes the cache.
 */
export async function readPackOptions(
  paths: LauncherPaths,
  instanceId: string,
  baseUrl: string,
  side: 'client' | 'server',
  opts: { signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<PackOption[]> {
  const log = opts.log ?? console.log
  const previous = await loadState(statePathFor(paths, instanceId), log)
  if (previous?.optionList) return previous.optionList
  const remote = await fetchRemotePack(baseUrl, opts.signal, log)
  const metafiles = await fetchMetafiles(remote, opts.signal, log)
  return optionsOf(remote, metafiles, side)
}

// ---------------------------------------------------------------------------
// Small readers used before the sync (versions for the install phases, launcher.json for the UI)
// ---------------------------------------------------------------------------

export async function readPackVersions(baseUrl: string): Promise<{ minecraft: string; neoforge: string }> {
  assertBaseUrl(baseUrl)
  const packUrl = new URL('pack.toml', baseUrl).href
  const pack = parsePackToml(decodeUtf8(await fetchBytes(packUrl, NO_STORE)), packUrl)
  return { ...pack.versions }
}

function isNewsItem(value: unknown): value is LauncherJson['news'][number] {
  return isRecord(value) && typeof value['date'] === 'string' && typeof value['title'] === 'string' && typeof value['text'] === 'string'
}

/** The optional-entry rules of launcher.json; both fields are optional in the file and ignored when malformed. */
function parseOptionRules(raw: Record<string, unknown>): OptionRules {
  const disables = raw['lowPresetDisables']
  const lowPresetDisables = Array.isArray(disables) ? disables.filter((v): v is string => typeof v === 'string' && v !== '') : []
  const optionRequires: Record<string, string> = {}
  const requires = raw['optionRequires']
  if (isRecord(requires)) {
    for (const [file, required] of Object.entries(requires)) if (typeof required === 'string' && required !== '') optionRequires[file] = required
  }
  return { lowPresetDisables, optionRequires }
}

export async function readLauncherJson(baseUrl: string): Promise<LauncherJson> {
  assertBaseUrl(baseUrl)
  const url = new URL('launcher.json', baseUrl).href
  const raw = await fetchJson<unknown>(url, NO_STORE)
  const what = `The launcher information file (${url})`
  if (!isRecord(raw)) throw new PackError(`${what} is malformed`)
  if (raw['schemaVersion'] !== 1) {
    throw new PackError(`${what} uses schema version ${String(raw['schemaVersion'])}, please update the launcher`)
  }
  const server = raw['server']
  if (!isRecord(server) || typeof server['name'] !== 'string' || typeof server['address'] !== 'string') {
    throw new PackError(`${what} is missing the server name or address`)
  }
  if (typeof raw['minLauncherVersion'] !== 'string' || typeof raw['motd'] !== 'string') {
    throw new PackError(`${what} is missing minLauncherVersion or motd`)
  }
  const news = Array.isArray(raw['news']) ? raw['news'] : []
  return {
    schemaVersion: 1,
    minLauncherVersion: raw['minLauncherVersion'],
    server: { name: server['name'], address: server['address'] },
    motd: raw['motd'],
    news: news.filter(isNewsItem).map((n) => ({ date: n.date, title: n.title, text: n.text })),
    ...parseOptionRules(raw),
  }
}
