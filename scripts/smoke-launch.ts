// Smoke test for src/main/core/launch.ts and settings.ts against a real install.
//
//   npx tsx scripts/smoke-launch.ts <root>
//
// Installs Java, Minecraft and NeoForge into <root> when they are missing (the ensure* calls
// are idempotent), syncs the live pack into the "consortium" instance, checks that a java that
// cannot start is reported as an error instead of a dead process, then starts the game in demo
// mode with a placeholder profile and watches <root>/logs/game-latest.log. The game window opens
// on the desktop for up to a minute and a half; it is killed once NeoForge, the test mods (jei,
// jade) and a window-ready line show up in the log, or after 90 s when the process is still alive
// and logging. Exits 1 on the first failed check.

import { spawnSync, type ChildProcess } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { INSTANCE_ID, PACK_BASE_URL } from '../src/main/core/config'
import { ensureJava } from '../src/main/core/java'
import {
  defaultPreset,
  describeCommand,
  finalizeArguments,
  GAME_LOG_NAME,
  launchGame,
  LaunchError,
  type LaunchRequest,
  lowPreset,
  mergeOptionsText,
} from '../src/main/core/launch'
import { ensureNeoForge } from '../src/main/core/neoforge'
import { syncPack } from '../src/main/core/pack'
import { resolvePaths } from '../src/main/core/paths'
import { loadSettings, presetFor, saveSettings, settingsPath } from '../src/main/core/settings'
import { ensureVanilla } from '../src/main/core/vanilla'
import type { ProgressEvent } from '../src/shared/types'

const MC_VERSION = '1.21.1'
const NEO_VERSION = '21.1.250'
const VERSION_ID = `neoforge-${NEO_VERSION}`
/** After this long a live process with a growing log counts as started even without the mod lines. */
const ALIVE_BUDGET_MS = 90_000
/** A live process whose log stopped growing for this long is treated as hung. */
const STALL_MS = 30_000
const TEST_MODS = ['jei', 'jade']
/** Lines the game prints once its window is up (the same markers @xmcl/core's process watcher uses). */
const WINDOW_READY_MARKERS = ['backend library: lwjgl', 'reloading resourcemanager', 'registering resource reload listener', 'openal initialized']

const rootArg = process.argv[2]
if (!rootArg) {
  console.error('usage: npx tsx scripts/smoke-launch.ts <root>')
  process.exit(1)
}
const root = resolve(rootArg)
const paths = resolvePaths(root)
const gameLogPath = join(paths.logs, GAME_LOG_NAME)

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`)
}

const started = Date.now()
const stamp = (): string => `[+${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`
const log = (line: string): void => console.log(`  ${stamp()} ${line}`)

let lastProgress = ''
let lastProgressAt = 0
function report(e: ProgressEvent): void {
  const now = Date.now()
  if (e.message === lastProgress && now - lastProgressAt < 1000) return
  lastProgress = e.message
  lastProgressAt = now
  const detail =
    e.current !== undefined && e.total !== undefined
      ? e.unit === 'bytes'
        ? ` ${(e.current / 1_048_576).toFixed(1)} / ${(e.total / 1_048_576).toFixed(1)} MB`
        : ` ${e.current} / ${e.total} ${e.unit ?? ''}`
      : ''
  log(`${e.phase}: ${e.message}${detail}`)
}

/** Collects launchGame's log lines; the game prints hundreds, so only the launcher's own lines are echoed. */
function collectingLog(lines: string[]): (line: string) => void {
  return (line) => {
    lines.push(line)
    if (!line.startsWith('game')) log(line)
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers: options.txt merge, argv fix-ups, presets, settings file
// ---------------------------------------------------------------------------------------------

function checkOptionsMerge(): void {
  console.log('\n== options.txt merge')
  const existing = 'version:3955\r\nrenderDistance:12\r\nfov:0.0\r\nrenderClouds:"true"\r\nlang:en_us\r\n'
  const merged = mergeOptionsText(existing, lowPreset().optionsOverrides)
  const lines = merged.split('\r\n')
  check(merged.endsWith('\r\n'), 'CRLF style of the existing file is kept')
  check(lines[0] === 'version:3955' && lines[1] === 'renderDistance:6' && lines[2] === 'fov:0.0', `order and unknown keys kept: ${JSON.stringify(lines)}`)
  check(lines[3] === 'renderClouds:"false"' && lines[4] === 'lang:en_us', `overridden in place: ${JSON.stringify(lines)}`)
  check(lines.includes('graphicsMode:0') && lines.includes('maxFps:60') && lines.includes('particles:2') && lines.includes('entityShadows:false'), 'missing keys appended')
  check(!merged.includes('\n\n'), 'no blank lines introduced')
  const fresh = mergeOptionsText('', { renderDistance: '6' })
  check(fresh === 'renderDistance:6\n', `fresh file content: ${JSON.stringify(fresh)}`)
  check(mergeOptionsText(existing, {}) === existing, 'no overrides leaves the text untouched')
  check(mergeOptionsText('a:1\nb:2', { b: '3' }) === 'a:1\nb:3\n', 'file without trailing newline gets one')
  console.log('  ok: overrides merged in place, unknown keys and ordering preserved')
}

function checkArguments(): void {
  console.log('\n== argv fix-ups')
  const argv = ['-Xmx4096M', '-Dlog4j.configurationFile=C:\\x\\client-1.12.xml', '-cp', 'a;b', 'net.Main', '--username', 'Player', '--clientId', '${clientid}', '--xuid', '${auth_xuid}', '--userType', 'msa', '--demo']
  const dropped = finalizeArguments(argv, { clientid: undefined, auth_xuid: undefined })
  check(!dropped.some((a) => a.includes('${')), `placeholders dropped: ${dropped.join(' ')}`)
  check(!dropped.includes('--clientId') && !dropped.includes('--xuid'), `orphan flags dropped: ${dropped.join(' ')}`)
  check(!dropped.some((a) => a.startsWith('-Dlog4j')), 'log4j config dropped')
  check(dropped.join(' ') === '-Xmx4096M -cp a;b net.Main --username Player --userType msa --demo', `remaining argv intact: ${dropped.join(' ')}`)
  const filled = finalizeArguments(argv, { clientid: 'cid', auth_xuid: '123' })
  check(filled.includes('--clientId') && filled[filled.indexOf('--clientId') + 1] === 'cid', 'clientId substituted')
  check(filled.includes('--xuid') && filled[filled.indexOf('--xuid') + 1] === '123', 'xuid substituted')
  const shown = describeCommand(['java', '-cp', 'a;b;c', 'net.Main', '--accessToken', 'secret-token-value-0123', 'x'], 'secret-token-value-0123')
  check(!shown.includes('secret') && shown.includes('<hidden>') && shown.includes('<3 entries>'), `command description: ${shown}`)
  console.log('  ok: placeholders dropped or substituted, token hidden in the logged command')
}

function checkPresets(): void {
  console.log('\n== presets')
  const gb = (n: number): number => n * 1024 * 1024 * 1024
  // os.totalmem() reports a little less than the sticker size on real machines.
  check(defaultPreset(gb(16) - 100 * 1024 * 1024).maxMemoryMb === 6144, '16 GB -> 6144')
  check(defaultPreset(gb(8) - 50 * 1024 * 1024).maxMemoryMb === 4096, '8 GB -> 4096')
  check(defaultPreset(gb(32)).maxMemoryMb === 8192, '32 GB -> clamped to 8192')
  check(defaultPreset(gb(4)).maxMemoryMb === 2048, '4 GB -> clamped to 2048')
  check(defaultPreset(gb(12)).maxMemoryMb === 4864, `12 GB -> 40% rounded to 256 MB (got ${defaultPreset(gb(12)).maxMemoryMb})`)
  check(defaultPreset(0).maxMemoryMb === 4096, 'unknown RAM -> 4096')
  for (const preset of [defaultPreset(gb(16)), lowPreset()]) {
    check(preset.extraJvmArgs.includes('-XX:+UseG1GC') && !preset.extraJvmArgs.some((a) => a.startsWith('-Xmx')), `${preset.id}: G1 flags without -Xmx`)
  }
  check(lowPreset().maxMemoryMb === 3072 && lowPreset().optionsOverrides['renderDistance'] === '6' && lowPreset().optionsOverrides['graphicsMode'] === '0', 'low preset values')
  check(Object.keys(defaultPreset(gb(16)).optionsOverrides).length === 0, 'default preset has no options overrides')
  check(presetFor({ preset: 'low' }, gb(16)).id === 'low', 'presetFor picks low')
  check(presetFor({ preset: 'default' }, gb(16)).maxMemoryMb === 6144, 'presetFor picks default')
  check(presetFor({ preset: 'default', maxMemoryMb: 8000 }, gb(16)).maxMemoryMb === 8000, 'override applied')
  check(presetFor({ preset: 'low', maxMemoryMb: 100 }, gb(16)).maxMemoryMb === 2048, 'override clamped up to 2048')
  check(presetFor({ preset: 'default', maxMemoryMb: 99999 }, gb(16)).maxMemoryMb === 12288, 'override clamped down to 12288')
  console.log('  ok: default 6144/4096/40% rule, low 3072, override clamped 2048..12288')
}

async function checkSettingsFile(): Promise<void> {
  console.log('\n== settings.json')
  const file = settingsPath(paths)
  const previous = await readFile(file, 'utf8').catch(() => null)
  try {
    await rm(file, { force: true })
    const fresh = await loadSettings(paths, { log })
    check(fresh.preset === 'default' && fresh.maxMemoryMb === undefined, `missing file -> defaults (${JSON.stringify(fresh)})`)
    await saveSettings(paths, { preset: 'low', maxMemoryMb: 5000 })
    const back = await loadSettings(paths, { log })
    check(back.preset === 'low' && back.maxMemoryMb === 5000, `round trip (${JSON.stringify(back)})`)
    await writeFile(file, '{ this is not json', 'utf8')
    const damaged = await loadSettings(paths, { log })
    check(damaged.preset === 'default', 'damaged file -> defaults')
    await writeFile(file, JSON.stringify({ preset: 'turbo', maxMemoryMb: 'lots', extra: true }), 'utf8')
    const odd = await loadSettings(paths, { log })
    check(odd.preset === 'default' && odd.maxMemoryMb === undefined, `unknown values sanitized (${JSON.stringify(odd)})`)
    console.log(`  ok: ${file}`)
  } finally {
    if (previous === null) await rm(file, { force: true })
    else await writeFile(file, previous, 'utf8')
  }
}

// ---------------------------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------------------------

async function installAndSync(): Promise<string> {
  console.log('\n== install (idempotent)')
  const java = await ensureJava(paths, report, { log })
  await ensureVanilla(paths, MC_VERSION, report, { log })
  const versionId = await ensureNeoForge(paths, MC_VERSION, NEO_VERSION, java.javaPath, report, { log })
  check(versionId === VERSION_ID, `version id ${versionId}`)

  console.log('\n== pack sync')
  const sync = await syncPack({ paths, instanceId: INSTANCE_ID, baseUrl: PACK_BASE_URL, side: 'client', report, log })
  log(`pack ${sync.pack.name} ${sync.pack.version}: ${sync.pack.files} files, downloaded ${sync.downloaded}, skipped ${sync.skipped}, unchanged ${sync.unchanged}`)
  check(sync.pack.neoforge === NEO_VERSION, `pack wants NeoForge ${sync.pack.neoforge}, this test launches ${NEO_VERSION}`)
  return java.javaPath
}

function baseRequest(javaPath: string, launcherLines: string[]): LaunchRequest {
  return {
    paths,
    instanceId: INSTANCE_ID,
    versionId: VERSION_ID,
    javaPath,
    preset: defaultPreset(totalmem()),
    profile: { name: 'Player', id: '00000000000000000000000000000000' },
    accessToken: '0',
    demo: true,
    log: collectingLog(launcherLines),
  }
}

/** Runs launchGame expecting it to reject; a process that starts anyway is killed and reported. */
async function expectLaunchFailure(request: LaunchRequest, what: string): Promise<LaunchError> {
  const result = await launchGame(request).then(
    (proc) => {
      killTree(proc)
      return null
    },
    (err: unknown) => err,
  )
  check(result !== null, `${what}: launchGame resolved with a running process`)
  check(result instanceof LaunchError, `${what}: rejects with a LaunchError (got ${String(result)})`)
  check(!result.message.includes('missing or damaged'), `${what}: not mistaken for damaged game files: ${result.message}`)
  return result
}

/** The game log must explain a start that failed, whichever way the OS reported it. */
async function checkFailedStartInGameLog(): Promise<void> {
  const logText = await readFile(gameLogPath, 'utf8')
  check(logText.startsWith('# Consortium Launcher'), 'game-latest.log starts with the launcher header')
  check(/\n# the game process failed to start: /.test(logText), `game-latest.log records the failed start: ${JSON.stringify(logText.slice(-200))}`)
}

/**
 * A java that passes the existence check but cannot start must reject launchGame with a readable
 * message. The OS reports that two ways: spawn() throws at once (damaged program file on Windows,
 * command line too long), or Node emits 'error' and 'close' a tick later without ever emitting
 * 'exit' (missing file, directory, no exec bit), which used to leave the launcher stuck on "running".
 */
async function checkStartFailures(javaPath: string): Promise<void> {
  console.log('\n== start failures (damaged java, directory as java, command line too long)')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  // Plain text in place of the program: Windows refuses it inside spawn() (UNKNOWN or EFTYPE),
  // mac/linux report the missing exec bit as an EACCES 'error' event.
  const fakeJava = join(paths.runtime, `fake-java${suffix}`)
  await writeFile(fakeJava, 'not a program', 'utf8')
  try {
    const lines: string[] = []
    const damaged = await expectLaunchFailure(baseRequest(fakeJava, lines), 'damaged java')
    log(`rejected: ${damaged.message}`)
    check(damaged.message.includes('could not be started') && damaged.message.includes(fakeJava), `message names the java path: ${damaged.message}`)
    check(lines.some((l) => l.startsWith('launch: spawn failed (') || l.startsWith('launch: the game process failed to start: ')), 'failed start logged')
    await checkFailedStartInGameLog()
  } finally {
    await rm(fakeJava, { force: true })
  }

  // A directory passes access() and then fails inside the OS after spawn() returned (ENOENT on
  // Windows, EACCES on mac/linux): the 'error'-only path, which must reject before launchGame returns.
  const dirLines: string[] = []
  const t0 = Date.now()
  const directory = await expectLaunchFailure(baseRequest(paths.runtime, dirLines), 'directory as java')
  log(`rejected in ${Date.now() - t0} ms: ${directory.message}`)
  check(directory.message.includes('could not be started') && directory.message.includes(paths.runtime), `message names the java path: ${directory.message}`)
  check(dirLines.some((l) => l.startsWith('launch: the game process failed to start: ')), `the error event reached the launcher log: ${dirLines.filter((l) => l.startsWith('launch:')).join(' | ')}`)
  check(!dirLines.some((l) => l.startsWith('launch: started ')), 'no "started" line for a process that never ran')
  await checkFailedStartInGameLog()

  // One JVM argument past the platform limit (32 KB total on Windows, 128 KB per argument on
  // Linux, 1 MB total on macOS) makes spawn() itself throw ENAMETOOLONG / E2BIG.
  const huge = 'x'.repeat(process.platform === 'win32' ? 40_000 : 1_200_000)
  const longLines: string[] = []
  const request = baseRequest(javaPath, longLines)
  request.preset = { ...request.preset, extraJvmArgs: [...request.preset.extraJvmArgs, `-Dconsortium.smoke=${huge}`] }
  const tooLong = await expectLaunchFailure(request, 'over-long command line')
  log(`rejected: ${tooLong.message.slice(0, 160)}`)
  check(tooLong.message.includes('too long') && tooLong.message.includes(paths.root), `message explains the length and names the data folder: ${tooLong.message}`)
  check(!tooLong.message.includes(huge.slice(0, 100)), 'the huge argument is not echoed in the message')
  check(longLines.some((l) => l.startsWith('launch: spawn failed (')), 'spawn failure logged with the command line length')
  check(!longLines.some((l) => l.includes(huge.slice(0, 100))), 'the huge argument is not echoed in the launcher log')
  await checkFailedStartInGameLog()
  console.log('  ok: all three failures rejected launchGame with a player-facing LaunchError')
}

interface Watch {
  loaderSeen: boolean
  mods: string[]
  /** The first window-ready marker seen, if any. */
  windowReady: string | null
  size: number
  lastGrowth: number
}

async function scanGameLog(watch: Watch): Promise<void> {
  const size = await stat(gameLogPath).then((s) => s.size, () => 0)
  if (size !== watch.size) {
    watch.size = size
    watch.lastGrowth = Date.now()
  }
  const text = (await readFile(gameLogPath, 'utf8').catch(() => '')).toLowerCase()
  // The launcher's own header mentions the version id, so only game lines count.
  const gameLines = text.split('\n').filter((l) => !l.startsWith('#'))
  const body = gameLines.join('\n')
  if (!watch.loaderSeen) watch.loaderSeen = body.includes('neoforge') || body.includes('fml')
  for (const mod of TEST_MODS) {
    if (!watch.mods.includes(mod) && new RegExp(`\\b${mod}\\b`).test(body)) watch.mods.push(mod)
  }
  if (watch.windowReady === null) watch.windowReady = WINDOW_READY_MARKERS.find((m) => body.includes(m)) ?? null
}

function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    proc.kill('SIGKILL')
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null) return true
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function printLogTail(count: number): Promise<void> {
  const text = await readFile(gameLogPath, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  console.error(`\n--- last ${Math.min(count, lines.length)} of ${lines.length} lines of ${gameLogPath} ---`)
  for (const line of lines.slice(-count)) console.error(line)
}

async function launchAndWatch(javaPath: string): Promise<void> {
  console.log('\n== launch (demo mode, a game window will open)')
  const launcherLines: string[] = []
  const t0 = Date.now()
  const proc = await launchGame(baseRequest(javaPath, launcherLines))
  log(`launchGame returned in ${Date.now() - t0} ms, pid ${String(proc.pid)}`)
  check(proc.pid !== undefined, 'the returned process has a pid')
  const command = launcherLines.find((l) => l.startsWith('launch: command '))
  check(command !== undefined, 'launcher logged the command line')
  check(!command.includes('${'), `no unsubstituted placeholder in the command: ${command}`)
  check(command.includes(`-Xmx${defaultPreset(totalmem()).maxMemoryMb}M`), 'command carries -Xmx')
  check(command.includes('--demo') && command.includes('--userType msa'), 'command carries --demo and --userType msa')
  check(!command.includes('-Dlog4j.configurationFile'), 'Mojang XML log config dropped')

  const watch: Watch = { loaderSeen: false, mods: [], windowReady: null, size: 0, lastGrowth: Date.now() }
  let outcome: 'ready' | 'alive' | null = null
  let failure: string | null = null
  const launchedAt = Date.now()
  let lastStatus = ''
  while (outcome === null && failure === null) {
    await sleep(1000)
    await scanGameLog(watch)
    const elapsed = Date.now() - launchedAt
    const status = `loader=${watch.loaderSeen} mods=${watch.mods.join(',') || '-'} window=${watch.windowReady ?? '-'} log=${(watch.size / 1024).toFixed(0)} KB`
    if (status !== lastStatus) {
      lastStatus = status
      log(status)
    }
    if (proc.exitCode !== null) {
      failure = `the game exited early with code ${String(proc.exitCode)} after ${(elapsed / 1000).toFixed(1)} s`
    } else if (watch.loaderSeen && watch.mods.length > 0 && watch.windowReady !== null) {
      outcome = 'ready'
    } else if (elapsed >= ALIVE_BUDGET_MS) {
      if (Date.now() - watch.lastGrowth < STALL_MS) outcome = 'alive'
      else failure = `the game is still running after ${(elapsed / 1000).toFixed(0)} s but its log stopped growing (loader=${watch.loaderSeen}, mods=${watch.mods.join(',') || 'none'})`
    } else if (Date.now() - watch.lastGrowth >= STALL_MS && watch.size > 0) {
      failure = `the game log stopped growing for ${STALL_MS / 1000} s (loader=${watch.loaderSeen}, mods=${watch.mods.join(',') || 'none'})`
    }
  }

  log(`stopping the game (pid ${String(proc.pid)})`)
  killTree(proc)
  const exited = await waitForExit(proc, 15_000)
  check(exited, 'game process ended after taskkill')
  check(launcherLines.some((l) => l.startsWith('launch: game exited with code ')), 'exit code logged')
  const fileText = await readFile(gameLogPath, 'utf8')
  check(fileText.startsWith('# Consortium Launcher'), 'game-latest.log starts with the launcher header')
  check(/\n# game exited with code /.test(fileText), 'game-latest.log ends with the exit line')
  check(launcherLines.some((l) => l.startsWith('game: ')), 'game output reached the log callback')

  if (failure !== null) {
    await printLogTail(60)
    throw new Error(failure)
  }
  const found = watch.mods.length > 0 ? watch.mods.join(', ') : 'none seen yet, process alive with a growing log'
  if (outcome === 'alive') log('note: the expected log lines did not all show up within 90 s, but the game is alive and still logging')
  else log(`game window came up ("${watch.windowReady ?? ''}") ${((Date.now() - launchedAt) / 1000).toFixed(1)} s after launch`)
  console.log(`\nOK: game started (NeoForge ${NEO_VERSION}, mods: ${found})`)
}

async function main(): Promise<void> {
  console.log(`root: ${root}`)
  checkOptionsMerge()
  checkArguments()
  checkPresets()
  await checkSettingsFile()
  const javaPath = await installAndSync()
  await checkStartFailures(javaPath)
  await launchAndWatch(javaPath)
}

main().catch((err: unknown) => {
  console.error('\nFAILED: ' + (err instanceof Error ? err.stack ?? err.message : String(err)))
  process.exit(1)
})
