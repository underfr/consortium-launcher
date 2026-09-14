// Starts the game: writes the preset's options.txt overrides, lets @xmcl/core build the
// command line and run its prechecks (jar and library hashes, natives extraction), then spawns
// one java process whose output is mirrored to <root>/logs/game-latest.log.

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { createQuickPlayMultiplayer, launch, MinecraftFolder, Version, type ResolvedVersion } from '@xmcl/core'
import pkg from '../../../package.json'
import type { LaunchPreset } from '../../shared/types'
import type { LauncherPaths } from './paths'

export interface LaunchRequest {
  paths: LauncherPaths
  instanceId: string
  /** e.g. 'neoforge-21.1.250' */
  versionId: string
  javaPath: string
  preset: LaunchPreset
  profile: { name: string; id: string }
  accessToken: string
  xuid?: string
  clientId?: string
  /** Joins this server right after the title screen (quickPlayMultiplayer). */
  server?: { host: string; port?: number }
  /** Adds --demo; used only by the dev smoke test so the game boots without a valid token. */
  demo?: boolean
  log?: (line: string) => void
}

export class LaunchError extends Error {
  override name = 'LaunchError'
}

/** The G1 flags the official launcher uses; -Xmx is added separately from the preset. */
export const MOJANG_JVM_ARGS: readonly string[] = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:MaxGCPauseMillis=50',
  '-XX:G1HeapRegionSize=32M',
]

/**
 * options.txt values of the low preset for Minecraft 1.21: graphicsMode 0 is "Fast" (covers
 * leaves and other fancy geometry), particles 2 is "Minimal". renderClouds is a string option
 * in 1.21, so its value must keep the quotes or the game rejects it and keeps the default.
 */
export const LOW_PRESET_OPTIONS: Readonly<Record<string, string>> = {
  renderDistance: '6',
  graphicsMode: '0',
  renderClouds: '"false"',
  particles: '2',
  entityShadows: 'false',
  maxFps: '60',
}

/** The game log mirrored from the process output, truncated at every launch. */
export const GAME_LOG_NAME = 'game-latest.log'

const LAUNCHER_NAME = 'consortium-launcher'

/** Memory for machines that are not the common 8 GB / 16 GB sizes: 40% of RAM within these bounds. */
const DEFAULT_MIN_MB = 2048
const DEFAULT_MAX_MB = 8192

/**
 * 16 GB machines get 6144 MB and 8 GB machines 4096 MB (the values players expect from other
 * launchers); anything else gets 40% of RAM rounded to 256 MB and clamped to 2048..8192.
 */
export function defaultPreset(totalMemoryBytes: number): LaunchPreset {
  const totalMb = Number.isFinite(totalMemoryBytes) && totalMemoryBytes > 0 ? totalMemoryBytes / 1_048_576 : 0
  // os.totalmem() reports a little under the nominal size (15.9 GB on a 16 GB machine).
  const nominalGb = Math.round(totalMb / 1024)
  let maxMemoryMb: number
  if (nominalGb === 16) maxMemoryMb = 6144
  else if (nominalGb === 8) maxMemoryMb = 4096
  else if (totalMb === 0) maxMemoryMb = 4096
  else maxMemoryMb = clamp(Math.round((totalMb * 0.4) / 256) * 256, DEFAULT_MIN_MB, DEFAULT_MAX_MB)
  return { id: 'default', maxMemoryMb, extraJvmArgs: [...MOJANG_JVM_ARGS], optionsOverrides: {} }
}

/** 3 GB heap and light graphics settings for weak machines. */
export function lowPreset(): LaunchPreset {
  return { id: 'low', maxMemoryMb: 3072, extraJvmArgs: [...MOJANG_JVM_ARGS], optionsOverrides: { ...LOW_PRESET_OPTIONS } }
}

/**
 * Starts Minecraft and returns the running process. The promise only resolves once the java
 * process is actually running: a start that fails (blocked or damaged executable, command line
 * too long) rejects with a LaunchError instead of handing back a dead process. The caller owns
 * the process: listen for 'exit' to know when the player closed the game. Output lines are
 * written to <paths.logs>/game-latest.log and passed to req.log; the exit code is logged too.
 */
export async function launchGame(req: LaunchRequest): Promise<ChildProcess> {
  const log = req.log ?? console.log
  const { paths, preset } = req
  validateRequest(req)
  if (!(await javaExists(req.javaPath))) {
    throw new LaunchError(`Java was not found at ${req.javaPath}. Click Play again so the launcher can reinstall it.`)
  }

  const instanceDir = paths.instance(req.instanceId)
  await mkdir(instanceDir, { recursive: true })
  await mkdir(paths.logs, { recursive: true })

  if (Object.keys(preset.optionsOverrides).length > 0) {
    await writeOptionsOverrides(instanceDir, preset.optionsOverrides)
    log(`launch: applied ${Object.keys(preset.optionsOverrides).length} options.txt override(s) for preset "${preset.id}"`)
  }

  const folder = MinecraftFolder.from(paths.minecraft)
  const resolved = await resolveVersion(folder, req.versionId)

  const logPath = join(paths.logs, GAME_LOG_NAME)
  const gameLog = createWriteStream(logPath, { flags: 'w', encoding: 'utf8' })
  // A failing log file must never take the game down with it.
  gameLog.on('error', (err) => log(`launch: cannot write ${logPath}: ${err.message}`))
  const writeLine = (line: string): void => {
    if (!gameLog.destroyed && !gameLog.writableEnded) gameLog.write(line + '\n')
  }
  let finished = false
  const finish = (line: string): void => {
    if (finished) return
    finished = true
    writeLine(`# ${line}`)
    gameLog.end()
  }
  writeLine(`# Consortium Launcher ${pkg.version} game log, started ${new Date().toISOString()}`)
  writeLine(`# version ${resolved.id} | java ${req.javaPath} | -Xmx${preset.maxMemoryMb}M | preset ${preset.id} | instance ${instanceDir}`)

  let commandLine: string[] = []
  // Set by the spawn hook when spawn() itself throws (ENAMETOOLONG on Windows, E2BIG elsewhere),
  // so the catch below can tell a start failure from a failed file check.
  let spawnError: unknown
  let proc: ChildProcess
  try {
    proc = await launch({
      gamePath: instanceDir,
      resourcePath: paths.minecraft,
      javaPath: req.javaPath,
      version: resolved,
      gameProfile: { name: req.profile.name, id: req.profile.id },
      accessToken: req.accessToken,
      // userType defaults to "msa" inside the library (its type only lists the legacy values).
      maxMemory: preset.maxMemoryMb,
      extraJVMArgs: [...preset.extraJvmArgs],
      quickPlayMultiplayer: req.server ? createQuickPlayMultiplayer(req.server.host, req.server.port) : undefined,
      demo: req.demo === true,
      launcherName: LAUNCHER_NAME,
      launcherBrand: pkg.version,
      extraExecOption: { windowsHide: true },
      // The library leaves ${clientid} and ${auth_xuid} unsubstituted, so the argv is fixed up
      // here, right before the process starts, and spawned with piped output.
      spawn: (command, args = [], options = {}) => {
        const finalArgs = finalizeArguments(args, { clientid: req.clientId, auth_xuid: req.xuid })
        commandLine = [command, ...finalArgs]
        try {
          return spawn(command, finalArgs, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (err) {
          spawnError = err
          throw err
        }
      },
    })
  } catch (err) {
    if (spawnError !== undefined) {
      // The command line is not logged here: an over-long one is the likely cause.
      log(`launch: spawn failed (${describeLaunchError(spawnError)}), command line of ${commandLineLength(commandLine)} characters`)
      const message = describeStartFailure(spawnError, req.javaPath, paths.root)
      finish(`the game process failed to start: ${describeLaunchError(spawnError)}`)
      await logClosed(gameLog)
      throw new LaunchError(message)
    }
    finish(`prechecks failed: ${describeLaunchError(err)}`)
    await logClosed(gameLog)
    throw new LaunchError(
      `The game files are missing or damaged (${describeLaunchError(err)}). Click Play again so the launcher can repair them.`,
    )
  }

  const shownCommand = describeCommand(commandLine, req.accessToken)
  writeLine(`# command: ${shownCommand}`)
  log(`launch: command ${shownCommand}`)

  pipeLines(proc.stdout, (line) => {
    writeLine(line)
    log(`game: ${line}`)
  })
  pipeLines(proc.stderr, (line) => {
    writeLine(line)
    log(`game stderr: ${line}`)
  })

  // 'on' rather than 'once': kill() can raise a second 'error' much later, and an 'error' event
  // without a listener would crash the launcher's main process.
  proc.on('error', (err) => {
    // pid stays undefined when the executable could not be started at all.
    if (proc.pid === undefined) {
      log(`launch: the game process failed to start: ${err.message}`)
      finish(`the game process failed to start: ${err.message}`)
    } else {
      log(`launch: the game process reported an error: ${err.message}`)
    }
  })
  proc.once('exit', (code, signal) => {
    log(`launch: game exited with code ${String(code)}${signal ? ` (signal ${signal})` : ''}`)
  })
  // 'close' fires after stdout/stderr are drained, so the exit line lands after the last output.
  proc.once('close', (code, signal) => finish(`game exited with code ${String(code)}${signal ? ` (signal ${signal})` : ''}`))

  try {
    await waitForStart(proc)
  } catch (err) {
    // The 'error' listener above has already closed the game log with the reason.
    await logClosed(gameLog)
    throw new LaunchError(describeStartFailure(err, req.javaPath, paths.root))
  }
  log(`launch: started ${resolved.id} as process ${String(proc.pid)}, log at ${logPath}`)
  return proc
}

/**
 * Resolves once the java process is actually running. Node reports a spawn that failed after
 * spawn() returned (missing, damaged or blocked executable) through 'error' and 'close' only,
 * never 'exit', so a caller waiting for 'exit' would wait forever; this turns that case into a
 * rejection before launchGame returns.
 */
function waitForStart(proc: ChildProcess): Promise<void> {
  // A successful spawn() sets pid synchronously; it stays undefined when the start failed and
  // the reason is about to arrive as an 'error' event.
  if (proc.pid !== undefined) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const cleanup = (): void => {
      proc.off('spawn', onSpawn)
      proc.off('error', onError)
    }
    proc.once('spawn', onSpawn)
    proc.once('error', onError)
  })
}

/** Waits until the game log has flushed and closed, so its last line is on disk before the caller sees the error. */
function logClosed(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve()
  return new Promise((resolve) => stream.once('close', resolve))
}

function validateRequest(req: LaunchRequest): void {
  if (!req.versionId) throw new LaunchError('No game version was selected. Try again.')
  if (!req.profile.name || !req.profile.id) throw new LaunchError('No Minecraft profile is signed in. Sign in and try again.')
  if (!Number.isInteger(req.preset.maxMemoryMb) || req.preset.maxMemoryMb <= 0) {
    throw new LaunchError(`The memory setting (${String(req.preset.maxMemoryMb)} MB) is not valid. Reset your settings and try again.`)
  }
}

async function resolveVersion(folder: MinecraftFolder, versionId: string): Promise<ResolvedVersion> {
  try {
    return await Version.parse(folder, versionId)
  } catch (err) {
    // Version.parse rejects with plain objects ({ error: 'MissingVersionJson', ... }), not Errors.
    throw new LaunchError(
      `Game version ${versionId} is not installed correctly (${describeLaunchError(err)}). Click Play again so the launcher can repair it.`,
    )
  }
}

/** Player-facing reason for a java process that could not be started at all. */
function describeStartFailure(err: unknown, javaPath: string, root: string): string {
  const detail = describeLaunchError(err)
  const code = errorCode(err)
  if (code === 'ENAMETOOLONG' || code === 'E2BIG') {
    return `The game command line is too long for this system (${detail}). Move the launcher data folder (${root}) to a shorter path, then click Play again.`
  }
  return `Minecraft could not be started (${detail}). Check that antivirus or system policies are not blocking ${javaPath}, then click Play again.`
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') return err.code
  return undefined
}

function describeLaunchError(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, ' ').trim()
  if (typeof err === 'object' && err !== null) {
    const obj = err as { error?: unknown; message?: unknown }
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    return JSON.stringify(err)
  }
  return String(err)
}

// ---------------------------------------------------------------------------------------------
// Command line fix-ups
// ---------------------------------------------------------------------------------------------

const BARE_PLACEHOLDER = /^\$\{([A-Za-z0-9_]+)\}$/

/**
 * Final pass over the argv @xmcl/core generated (without the java executable):
 * - a bare "${name}" placeholder is replaced by its value when one is known, otherwise it is
 *   dropped together with the "--flag" in front of it (clientId and xuid are optional for the game);
 * - Mojang's -Dlog4j.configurationFile is dropped: that config prints XML events on stdout, while
 *   NeoForge's bundled config prints readable lines and still writes logs/latest.log.
 */
export function finalizeArguments(args: readonly string[], values: Record<string, string | undefined>): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (arg.startsWith('-Dlog4j.configurationFile=')) continue
    const placeholder = BARE_PLACEHOLDER.exec(arg)
    if (!placeholder) {
      out.push(arg)
      continue
    }
    const value = values[placeholder[1]]
    if (value !== undefined && value !== '') {
      out.push(value)
      continue
    }
    const previous = out[out.length - 1]
    if (previous !== undefined && previous.startsWith('--')) out.pop()
  }
  return out
}

/** One line for the launcher log: the access token is hidden, class and module paths collapsed. */
export function describeCommand(argv: readonly string[], accessToken: string): string {
  const parts: string[] = []
  argv.forEach((arg, i) => {
    const previous = i > 0 ? argv[i - 1] : ''
    if (previous === '--accessToken' || (accessToken.length >= 16 && arg === accessToken)) parts.push('<hidden>')
    else if (previous === '-cp' || previous === '-p') parts.push(`<${arg.split(delimiter).length} entries>`)
    else parts.push(/\s/.test(arg) ? `"${arg}"` : arg)
  })
  return parts.join(' ')
}

/** Rough size of the command line as the OS sees it (arguments separated by one space). */
function commandLineLength(argv: readonly string[]): number {
  return argv.reduce((total, arg) => total + arg.length + 1, 0)
}

// ---------------------------------------------------------------------------------------------
// options.txt
// ---------------------------------------------------------------------------------------------

/**
 * Applies overrides to options.txt ("key:value" per line). Every other key keeps its value and
 * position, so the player's own settings survive; missing keys are appended and the file is
 * created when absent.
 */
export async function writeOptionsOverrides(instanceDir: string, overrides: Record<string, string>): Promise<void> {
  const file = join(instanceDir, 'options.txt')
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LaunchError(`Could not read ${file}: ${describeLaunchError(err)}`)
    }
  }
  const merged = mergeOptionsText(existing, overrides)
  if (merged === existing) return
  // Written next to the file and renamed so a crash mid-write never leaves a half options.txt.
  const tmp = file + '.tmp'
  try {
    await writeFile(tmp, merged, 'utf8')
    await rename(tmp, file)
  } catch (err) {
    throw new LaunchError(`Could not update ${file}: ${describeLaunchError(err)}`)
  }
}

/** Pure merge used by writeOptionsOverrides; exported so the smoke test can check it. */
export function mergeOptionsText(existing: string, overrides: Record<string, string>): string {
  for (const [key, value] of Object.entries(overrides)) {
    if (!key || /[:\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new LaunchError(`Invalid options.txt override "${key}"`)
    }
  }
  // Minecraft on Windows writes CRLF; keep whatever the file already uses.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const seen = new Set<string>()
  const out = lines.map((line) => {
    const colon = line.indexOf(':')
    if (colon <= 0) return line
    const key = line.slice(0, colon)
    const value = overrides[key]
    if (value === undefined) return line
    seen.add(key)
    return `${key}:${value}`
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (!seen.has(key)) out.push(`${key}:${value}`)
  }
  return out.length > 0 ? out.join(eol) + eol : ''
}

// ---------------------------------------------------------------------------------------------
// Process output
// ---------------------------------------------------------------------------------------------

function pipeLines(stream: Readable | null, onLine: (line: string) => void): void {
  if (!stream) return
  stream.setEncoding('utf8')
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Exported for callers that want to check the executable before showing a "Play" button. */
export async function javaExists(javaPath: string): Promise<boolean> {
  try {
    await access(javaPath)
    return true
  } catch {
    return false
  }
}
