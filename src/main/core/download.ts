// HTTPS downloader shared by every core module: host allow-list, streaming hash
// verification, atomic rename, retries and a fixed User-Agent. Pure Node, no Electron.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { ALLOWED_DOWNLOAD_HOSTS } from './config'

export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512' | 'md5'

export interface EnsureFileOptions {
  url: string
  dest: string
  hash?: { algorithm: HashAlgorithm; value: string }
  size?: number
  signal?: AbortSignal
  onProgress?: (downloadedBytes: number, totalBytes: number | undefined) => void
  log?: (line: string) => void
}

/** 'disk' = the file could not be written or renamed locally (full disk, read-only or locked folder). */
export type DownloadFailure = 'policy' | 'network' | 'status' | 'checksum' | 'content' | 'cancelled' | 'disk'

export class DownloadError extends Error {
  url: string
  dest?: string
  /** What went wrong, so callers (and the final retry message) can react without parsing text. */
  reason: DownloadFailure
  /** HTTP status when reason is 'status'. */
  status?: number

  constructor(
    message: string,
    url: string,
    extra?: { reason?: DownloadFailure; dest?: string; status?: number; cause?: unknown },
  ) {
    super(message, extra?.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'DownloadError'
    this.url = url
    this.dest = extra?.dest
    this.reason = extra?.reason ?? 'network'
    this.status = extra?.status
  }
}

/** 3 retries: waits 1 s, 3 s and 9 s between attempts. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000]
/** A download that receives no byte for this long is treated as a network error and retried. */
const STALL_TIMEOUT_MS = 30_000
/** Redirect hops fetchOnce follows before giving up; every hop is checked against the allow-list. */
const MAX_REDIRECTS = 5

// ---------------------------------------------------------------------------
// URL policy and User-Agent
// ---------------------------------------------------------------------------

/** Every request must be https and target one of the hosts in ALLOWED_DOWNLOAD_HOSTS. */
export function assertAllowedUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (err) {
    throw new DownloadError(`This download address is not valid: ${url}`, url, { reason: 'policy', cause: err })
  }
  if (parsed.protocol !== 'https:') {
    throw new DownloadError(`Only secure (https) downloads are allowed, refusing: ${url}`, url, { reason: 'policy' })
  }
  const host = parsed.hostname.toLowerCase()
  if (!ALLOWED_DOWNLOAD_HOSTS.includes(host)) {
    throw new DownloadError(`Downloads from ${host} are not allowed by this launcher, refusing: ${url}`, url, { reason: 'policy' })
  }
}

let cachedUserAgent: string | undefined

/**
 * "consortium-launcher/<version>" with the version read once from package.json. The file is
 * looked up by walking up from this module so it works from src/ (tsx), out/main (electron-vite)
 * and inside app.asar (the package.json sits at the asar root).
 */
export function userAgent(): string {
  if (cachedUserAgent) return cachedUserAgent
  let version = 'unknown'
  let dir = __dirname
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown }
        if (pkg.name === 'consortium-launcher' && typeof pkg.version === 'string') {
          version = pkg.version
          break
        }
      } catch {
        // Not our package.json (or unreadable): keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  cachedUserAgent = `consortium-launcher/${version}`
  return cachedUserAgent
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** Syscalls behind the fs calls this module makes (stream open/write/close, rename, mkdir, hashing reads). */
const LOCAL_FS_SYSCALLS = new Set(['open', 'read', 'write', 'writev', 'close', 'rename', 'mkdir', 'unlink', 'stat', 'fsync', 'ftruncate'])

/**
 * True for a Node fs error (ENOSPC, EACCES, EPERM, EISDIR, EEXIST...). Network failures from undici
 * carry their code on err.cause and never a file syscall, so this cannot mistake one for the other.
 */
function isLocalFsError(err: unknown): err is NodeJS.ErrnoException {
  if (!(err instanceof Error)) return false
  const syscall = (err as NodeJS.ErrnoException).syscall
  return typeof syscall === 'string' && LOCAL_FS_SYSCALLS.has(syscall)
}

/** Server-side or transient statuses are worth another attempt; other 4xx answers are final. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

/** True for failures that a fresh attempt may fix: network errors, checksum mismatches, 5xx. */
function isRetryable(err: unknown): boolean {
  if (isAbortError(err)) return false
  // A full disk or a read-only folder does not heal by itself; re-downloading would only waste time.
  if (isLocalFsError(err)) return false
  if (!(err instanceof DownloadError)) return true
  if (err.reason === 'status') return isRetryableStatus(err.status ?? 0)
  return err.reason === 'network' || err.reason === 'checksum'
}

/** Player-facing advice for the final failure, depending on what kept going wrong. */
function adviceFor(err: unknown): string {
  if (err instanceof DownloadError && err.reason === 'checksum') {
    return 'The file on the server does not match what the modpack expects. Try again later, and tell the pack maintainer if it keeps happening.'
  }
  return 'Check your internet connection and try again.'
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the socket error in "fetch failed"; the cause carries the useful code.
    const cause = err.cause
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`
    return err.message
  }
  return String(err)
}

/** Wraps a local fs failure into a DownloadError a player can act on. */
function diskError(err: NodeJS.ErrnoException, o: EnsureFileOptions): DownloadError {
  const code = err.code ?? 'unknown error'
  const advice =
    code === 'ENOSPC'
      ? 'Your disk is full. Free up some space and try again.'
      : code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        ? 'The file is read-only or locked by another program (an antivirus scan or the game itself). Close it and try again.'
        : 'Check that you have enough free disk space and that the launcher folder is not read-only or locked by another program.'
  return new DownloadError(`Could not save ${o.dest} (${code}). ${advice}`, o.url, { reason: 'disk', dest: o.dest, cause: err })
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * One request with the allow-list and User-Agent applied. Resolves only with a 2xx response.
 * Redirects are followed by hand so that every hop (not only the first URL) passes the policy:
 * undici would otherwise silently follow a 3xx to any host, even plain http.
 */
async function fetchOnce(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', userAgent())
  let current = url
  for (let hop = 0; ; hop++) {
    try {
      assertAllowedUrl(current)
    } catch (err) {
      if (hop === 0) throw err
      throw new DownloadError(`${url} redirected to ${current}, which this launcher is not allowed to download from`, url, { reason: 'policy', cause: err })
    }
    const res = await fetch(current, { ...init, headers, redirect: 'manual' })
    if (res.ok) return res
    await res.body?.cancel().catch(() => undefined)

    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location !== null) {
      if (hop >= MAX_REDIRECTS) {
        throw new DownloadError(`The server redirected ${url} more than ${MAX_REDIRECTS} times, giving up`, url, { reason: 'status', status: res.status })
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch (err) {
        throw new DownloadError(`The server sent an invalid redirect address for ${url}`, url, { reason: 'status', status: res.status, cause: err })
      }
      // Same rule as browsers: credentials never travel to another origin.
      if (next.origin !== new URL(current).origin) headers.delete('Authorization')
      current = next.href
      continue
    }
    throw new DownloadError(`The server answered ${res.status} ${res.statusText} for ${current}`, url, { reason: 'status', status: res.status })
  }
}

/**
 * Runs `attempt` up to 1 + RETRY_DELAYS_MS.length times. Aborts, final HTTP statuses and local
 * disk failures are thrown immediately; everything else waits for the backoff and tries again.
 */
async function withRetries<T>(
  attempt: () => Promise<T>,
  o: { url: string; dest?: string; signal?: AbortSignal; log: (line: string) => void },
): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await attempt()
    } catch (err) {
      if (o.signal?.aborted || isAbortError(err)) {
        throw new DownloadError(`Download cancelled: ${o.url}`, o.url, { reason: 'cancelled', dest: o.dest, cause: err })
      }
      if (!isRetryable(err)) throw err
      const delay = RETRY_DELAYS_MS.at(round)
      if (delay === undefined) {
        throw new DownloadError(
          `Could not download ${o.url} after ${RETRY_DELAYS_MS.length + 1} attempts (${describe(err)}). ${adviceFor(err)}`,
          o.url,
          { reason: err instanceof DownloadError ? err.reason : 'network', dest: o.dest, cause: err },
        )
      }
      o.log(`retrying ${o.url} in ${delay / 1000} s (${describe(err)})`)
      try {
        await sleep(delay, undefined, { signal: o.signal })
      } catch (abort) {
        throw new DownloadError(`Download cancelled: ${o.url}`, o.url, { reason: 'cancelled', dest: o.dest, cause: abort })
      }
    }
  }
}

const silent = (): void => undefined

export function fetchText(url: string, init?: RequestInit): Promise<string> {
  return withRetries(async () => (await fetchOnce(url, init)).text(), { url, signal: init?.signal ?? undefined, log: silent })
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const text = await fetchText(url, init)
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new DownloadError(`The file at ${url} is not valid JSON`, url, { reason: 'content', cause: err })
  }
}

/** Raw bytes, for files whose hash must be computed exactly as served (packwiz index and metafiles). */
export function fetchBytes(url: string, init?: RequestInit): Promise<Uint8Array> {
  return withRetries(
    async () => new Uint8Array(await (await fetchOnce(url, init)).arrayBuffer()),
    { url, signal: init?.signal ?? undefined, log: silent },
  )
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashBytes(data: Uint8Array | string, algorithm: HashAlgorithm): string {
  return createHash(algorithm).update(data).digest('hex')
}

export async function hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
  const hash = createHash(algorithm)
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// ---------------------------------------------------------------------------
// ensureFile
// ---------------------------------------------------------------------------

/** True when dest exists and matches the expected hash (or size when there is no hash). */
async function isValidOnDisk(o: EnsureFileOptions): Promise<boolean> {
  let info: Stats
  try {
    info = await stat(o.dest)
  } catch {
    return false
  }
  if (!info.isFile()) return false
  if (o.hash) return sameHash(await hashFile(o.dest, o.hash.algorithm), o.hash.value)
  if (o.size !== undefined) return info.size === o.size
  return true
}

/**
 * Streams the response into `part` while hashing, then verifies. Throws on any mismatch so the
 * caller can retry. The stall watchdog aborts a connection that stops sending bytes.
 */
async function downloadOnce(o: EnsureFileOptions, part: string): Promise<void> {
  const watchdog = new AbortController()
  const signal = o.signal ? AbortSignal.any([o.signal, watchdog.signal]) : watchdog.signal
  const stall = (): void => watchdog.abort(new DownloadError(`No data received for ${STALL_TIMEOUT_MS / 1000} s from ${o.url}`, o.url))
  let stallTimer = setTimeout(stall, STALL_TIMEOUT_MS)

  try {
    const res = await fetchOnce(o.url, { signal })
    if (!res.body) throw new DownloadError(`The server sent an empty answer for ${o.url}`, o.url, { dest: o.dest })

    const lengthHeader = res.headers.get('content-length')
    const total = lengthHeader ? Number(lengthHeader) : o.size
    const hash = o.hash ? createHash(o.hash.algorithm) : undefined
    let received = 0

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(stall, STALL_TIMEOUT_MS)
        hash?.update(chunk)
        received += chunk.length
        o.onProgress?.(received, total)
        callback(null, chunk)
      },
    })

    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal })

    if (hash && o.hash && !sameHash(hash.digest('hex'), o.hash.value)) {
      throw new DownloadError(
        `The downloaded file did not match its expected ${o.hash.algorithm} checksum: ${o.url}`,
        o.url,
        { reason: 'checksum', dest: o.dest },
      )
    }
    if (o.size !== undefined && received !== o.size) {
      throw new DownloadError(
        `The downloaded file has ${received} bytes but ${o.size} were expected: ${o.url}`,
        o.url,
        { reason: 'checksum', dest: o.dest },
      )
    }
  } catch (err) {
    // The watchdog abort must read as a network error (retryable), not as a player cancel.
    if (watchdog.signal.aborted && !o.signal?.aborted) throw watchdog.signal.reason
    throw err
  } finally {
    clearTimeout(stallTimer)
  }
}

/** Windows antivirus scanners lock a freshly written file for a moment; a few short waits cover that. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000]
const LOCK_CODES = new Set(['EBUSY', 'EPERM'])

/** Renames part over dest, waiting briefly when the file is transiently locked (no re-download needed). */
async function renameWithLockRetry(from: string, to: string, signal: AbortSignal | undefined): Promise<void> {
  for (let round = 0; ; round++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const delay = RENAME_RETRY_DELAYS_MS.at(round)
      if (delay === undefined || !isLocalFsError(err) || !LOCK_CODES.has(err.code ?? '')) throw err
      await sleep(delay, undefined, { signal })
    }
  }
}

/**
 * Returns 'cached' when dest already matches, otherwise downloads to dest + '.part', verifies,
 * renames atomically over dest and returns 'downloaded'. Retries on network errors, retryable
 * HTTP statuses and hash mismatches; an abort through o.signal stops immediately, and a local
 * disk failure is reported once as a DownloadError with reason 'disk'.
 */
export async function ensureFile(o: EnsureFileOptions): Promise<'cached' | 'downloaded'> {
  const log = o.log ?? console.log
  assertAllowedUrl(o.url)
  const part = o.dest + '.part'

  try {
    if (await isValidOnDisk(o)) return 'cached'
    await mkdir(dirname(o.dest), { recursive: true })
  } catch (err) {
    // The parent existing as a file, or an unreadable dest, must not surface as a raw Node error.
    throw isLocalFsError(err) ? diskError(err, o) : err
  }

  return withRetries(
    async () => {
      try {
        await downloadOnce(o, part)
        await renameWithLockRetry(part, o.dest, o.signal)
        return 'downloaded' as const
      } catch (err) {
        await rm(part, { force: true }).catch(() => undefined)
        throw isLocalFsError(err) ? diskError(err, o) : err
      }
    },
    { url: o.url, dest: o.dest, signal: o.signal, log },
  )
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Runs the tasks with at most `limit` in flight and returns their results in order. On the first
 * failure no new task is started; the promise rejects with that error once the running ones settle
 * so nothing keeps writing to disk after the caller gives up.
 */
export async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length)
  let next = 0
  let failure: { error: unknown } | undefined

  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = next++
      if (index >= tasks.length) return
      const task = tasks[index]
      if (!task) return
      try {
        results[index] = await task()
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker())
  await Promise.all(workers)
  if (failure) throw failure.error
  return results
}
