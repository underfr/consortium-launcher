// Bundled Java 21 (Mojang "java-runtime-delta") under <root>/runtime/java21.
// Also hosts two small helpers shared by vanilla.ts and neoforge.ts: the User-Agent sent on
// library-driven downloads and the bridge from @xmcl task updates to ProgressEvent.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { installJavaRuntimeTask } from '@xmcl/installer'
import type { AnyEntry, JavaRuntimeTarget, JavaRuntimes } from '@xmcl/installer'
import pkg from '../../../package.json'
import type { Phase, ProgressReporter } from '../../shared/types'
import { JAVA_RUNTIME_COMPONENT, MOJANG_JAVA_RUNTIME_INDEX } from './config'
import { javaExecutable, mojangPlatformKey, type LauncherPaths } from './paths'

export interface JavaInstall {
  javaPath: string
  /** e.g. "21.0.7" */
  version: string
}

export class JavaError extends Error {
  override name = 'JavaError'
}

/** Sent on every request the launcher makes, as required by the core contract. */
export const LAUNCHER_USER_AGENT = `consortium-launcher/${pkg.version}`

/** `headers` for the @xmcl/installer download options. */
export function libraryHeaders(): Record<string, string> {
  return { 'user-agent': LAUNCHER_USER_AGENT }
}

/** Global fetch with the launcher User-Agent and a readable error on non-2xx responses. */
export async function fetchWithAgent(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init?.headers)
  headers.set('user-agent', LAUNCHER_USER_AGENT)
  let res: Response
  try {
    res = await fetch(input, { ...init, headers })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not reach ${url} (${why}). Check your internet connection and try again.`)
  }
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}. Try again in a few minutes.`)
  return res
}

/** Written next to the runtime once `java -version` has been verified, so a half-downloaded
 *  runtime (launcher closed mid-install) is never trusted by the fast path. */
const VERIFIED_MARKER = '.verified'

/**
 * Installs or reuses the bundled Java 21. Fast path (no network, no child process): the
 * runtime's `release` file says JAVA_VERSION 21, the executable exists and the verified marker
 * is present. Otherwise the Mojang manifest is fetched and installJavaRuntimeTask fills in
 * whatever is missing (existing files are re-validated by sha1), then `java -version` is run.
 */
export async function ensureJava(
  paths: LauncherPaths,
  report: ProgressReporter,
  opts: { log?: (line: string) => void } = {},
): Promise<JavaInstall> {
  const log = opts.log ?? console.log
  const javaPath = javaExecutable(paths.java)
  report({ phase: 'java', message: 'Checking Java 21' })

  const installed = await readInstalledVersion(paths.java, javaPath)
  if (installed) {
    log(`java: cached ${installed} at ${javaPath}`)
    return { javaPath, version: installed }
  }

  const platform = mojangPlatformKey()
  if (!platform) {
    throw new JavaError(
      `This computer (${process.platform} ${process.arch}) is not supported by the Minecraft Java runtime.`,
    )
  }

  report({ phase: 'java', message: 'Looking up Java 21' })
  const index = (await (await fetchWithAgent(MOJANG_JAVA_RUNTIME_INDEX)).json()) as JavaRuntimes
  const target: JavaRuntimeTarget | undefined = index[platform]?.[JAVA_RUNTIME_COMPONENT]?.[0]
  if (!target) {
    throw new JavaError(`Mojang does not offer ${JAVA_RUNTIME_COMPONENT} for ${platform} yet. Try again later.`)
  }

  // The manifest is fetched by hand: fetchJavaRuntimeManifest() is broken in @xmcl/installer 6.1.2.
  const manifestBytes = Buffer.from(await (await fetchWithAgent(target.manifest.url)).arrayBuffer())
  const manifestSha1 = createHash('sha1').update(manifestBytes).digest('hex')
  if (manifestSha1 !== target.manifest.sha1) {
    throw new JavaError(
      `The Java runtime manifest from ${target.manifest.url} is corrupted (sha1 ${manifestSha1}, expected ${target.manifest.sha1}). Try again.`,
    )
  }
  const files = (JSON.parse(manifestBytes.toString('utf8')) as { files: Record<string, AnyEntry> }).files
  const entries = Object.entries(files)
  const totalBytes = entries.reduce((sum, [, e]) => sum + (e.type === 'file' ? e.downloads.raw.size : 0), 0)
  log(`java: installing ${target.version.name} (${entries.length} entries, ${formatMb(totalBytes)} MB) into ${paths.java}`)

  const progress = createTaskProgress('java', report, [
    { path: 'installJavaRuntime.download', message: 'Downloading Java 21', unit: 'bytes', total: totalBytes },
  ])
  report({ phase: 'java', message: 'Downloading Java 21', current: 0, total: totalBytes, unit: 'bytes' })
  try {
    await withRetries('java', log, () =>
      installJavaRuntimeTask({
        destination: paths.java,
        manifest: { target: JAVA_RUNTIME_COMPONENT, version: target.version, files },
        headers: libraryHeaders(),
      }).startAndWait(progress.context),
    )
  } catch (err) {
    throw new JavaError(`Downloading Java 21 failed: ${describeError(err)}. Check your internet connection and try again.`)
  }
  log(`java: transferred ${formatMb(progress.stats.transferredBytes)} MB`)

  // The library ignores the manifest's "executable" flag and fails silently on its "link"
  // entries; without this the JVM cannot start on mac/linux.
  await finishRuntimeLayout(paths.java, entries)

  report({ phase: 'java', message: 'Verifying Java 21' })
  const version = await probeJavaVersion(javaPath)
  if (!version.startsWith('21.')) {
    throw new JavaError(`The downloaded Java reports version ${version} instead of 21. Delete ${paths.java} and try again.`)
  }
  await writeFile(join(paths.java, VERIFIED_MARKER), version + '\n', 'utf8')
  log(`java: ${version} ready at ${javaPath}`)
  return { javaPath, version }
}

/** JAVA_VERSION from the runtime's `release` file when the fast-path conditions hold, else null. */
async function readInstalledVersion(runtimeDir: string, javaPath: string): Promise<string | null> {
  // The `release` file sits two levels above bin/java (on mac that is inside jre.bundle).
  const home = dirname(dirname(javaPath))
  const [hasExe, hasMarker] = await Promise.all([exists(javaPath), exists(join(runtimeDir, VERIFIED_MARKER))])
  if (!hasExe || !hasMarker) return null
  let release: string
  try {
    release = await readFile(join(home, 'release'), 'utf8')
  } catch {
    return null
  }
  const match = /^JAVA_VERSION="([^"]+)"/m.exec(release)
  if (!match || !match[1].startsWith('21')) return null
  return match[1]
}

/** chmod 0755 on executables and create the manifest's symbolic links (mac/linux only; the
 *  Windows manifest has neither). */
async function finishRuntimeLayout(root: string, entries: [string, AnyEntry][]): Promise<void> {
  if (process.platform === 'win32') return
  for (const [rel, entry] of entries) {
    const file = join(root, rel)
    try {
      if (entry.type === 'file' && entry.executable) {
        await chmod(file, 0o755)
      } else if (entry.type === 'link') {
        // Targets are relative to the link's own directory, exactly as symlink() expects.
        await symlink(entry.target, file).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err
        })
      }
    } catch (err) {
      throw new JavaError(`Could not set up ${file}: ${describeError(err)}`)
    }
  }
}

/** Runs `java -version` and returns the quoted version string (java prints it on stderr). */
function probeJavaVersion(javaPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new JavaError(`${javaPath} did not answer "java -version" within 30 seconds.`))
    }, 30_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new JavaError(`Could not start ${javaPath}: ${err.message}. Delete the runtime folder and try again.`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const match = /version "([^"]+)"/.exec(output)
      if (code !== 0 || !match) {
        reject(new JavaError(`${javaPath} failed to run (exit code ${String(code)}): ${output.trim() || 'no output'}`))
        return
      }
      resolve(match[1])
    })
  })
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function formatMb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

// ---------------------------------------------------------------------------------------------
// Helpers shared with vanilla.ts and neoforge.ts
// ---------------------------------------------------------------------------------------------

/**
 * One readable line for any error, including the AggregateErrors @xmcl/installer throws when
 * several of thousands of downloads fail: those are summarised as a count plus one example,
 * never joined (a flaky CDN once produced a 500 KB message).
 */
export function describeError(err: unknown): string {
  const flat = flattenErrors(err)
  const first = flat[0]
  const message = first instanceof Error ? first.message : String(first)
  const oneLine = message.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > 300 ? oneLine.slice(0, 300) + '...' : oneLine
  return flat.length > 1 ? `${flat.length} downloads failed, for example: ${clipped}` : clipped
}

function flattenErrors(err: unknown): unknown[] {
  if (err instanceof AggregateError) return err.errors.flatMap(flattenErrors)
  return [err]
}

/**
 * Runs an install step up to `attempts` times with a growing pause in between. The @xmcl
 * installers re-validate what is on disk on every run, so a retry only fetches the files that
 * failed (a mid-download disconnect leaves empty files that fail their hash check).
 */
export async function withRetries<T>(
  label: string,
  log: (line: string) => void,
  run: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run()
    } catch (err) {
      lastError = err
      if (attempt === attempts) break
      const pauseMs = attempt * 3000
      log(`${label}: attempt ${attempt} of ${attempts} failed (${describeError(err)}), retrying in ${pauseMs / 1000} s`)
      await new Promise((resolve) => setTimeout(resolve, pauseMs))
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------------------------
// Task progress bridge (shared with vanilla.ts and neoforge.ts)
// ---------------------------------------------------------------------------------------------

/** The part of an @xmcl/task Task that the bridge reads. */
interface TaskLike {
  readonly path: string
  readonly progress: number
  readonly total: number
}

type XmclTaskContext = NonNullable<Parameters<ReturnType<typeof installJavaRuntimeTask>['startAndWait']>[0]>

export interface TaskStage {
  /** Exact task path in the @xmcl task tree, e.g. "install.dependencies". */
  path: string
  message: string
  unit: 'bytes' | 'files'
  /** Use this instead of task.total when the library only learns sizes as downloads start. */
  total?: number
}

export interface TaskProgress {
  context: XmclTaskContext
  stats: { transferredBytes: number }
}

/**
 * Turns the firehose of task updates into at most ~4 ProgressEvents per second per stage.
 * Only tasks whose path matches a stage are reported. Updates that carry no bytes are the
 * library's bookkeeping for files it found already valid, so a fully cached run stays silent
 * and the player keeps seeing the "Checking ..." message instead of a fake download.
 */
export function createTaskProgress(phase: Phase, report: ProgressReporter, stages: TaskStage[]): TaskProgress {
  const byPath = new Map(stages.map((s) => [s.path, s]))
  const lastReport = new Map<string, number>()
  const completed = new Set<string>()
  const stats = { transferredBytes: 0 }

  const context: XmclTaskContext = {
    onUpdate(task: TaskLike, chunkSize: number) {
      const stage = byPath.get(task.path)
      if (!stage || chunkSize <= 0) return
      if (stage.unit === 'bytes') stats.transferredBytes += chunkSize
      const total = stage.total ?? task.total
      const current = Math.min(Math.max(task.progress, 0), total)
      const now = Date.now()
      // The first update that reaches 100% always goes out so the bar never stops short.
      const justDone = total > 0 && current >= total && !completed.has(stage.path)
      if (justDone) completed.add(stage.path)
      if (!justDone && now - (lastReport.get(stage.path) ?? 0) < 250) return
      lastReport.set(stage.path, now)
      if (total > 0) report({ phase, message: stage.message, current, total, unit: stage.unit })
      else report({ phase, message: stage.message })
    },
  }
  return { context, stats }
}
