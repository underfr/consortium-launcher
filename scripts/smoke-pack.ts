// Smoke test for src/main/core/pack.ts against the live test pack.
//
//   npx tsx scripts/smoke-pack.ts <root>
//
// The instance "consortium" and its sync state under <root> are reset at the start so every
// run exercises the fresh-install path. Runs 7 to 9 exercise the optional entries (Iris on, then
// off through the low preset rule, then steady state). Exits 1 on the first failed check.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { INSTANCE_ID, PACK_BASE_URL } from '../src/main/core/config'
import { DownloadError, ensureFile, fetchBytes } from '../src/main/core/download'
import { resolvePaths } from '../src/main/core/paths'
import { readLauncherJson, readPackOptions, readPackVersions, syncPack } from '../src/main/core/pack'
import { effectiveOptions } from '../src/main/core/settings'
import type { OptionRules, PackOption, ProgressEvent, Settings, SyncResult } from '../src/shared/types'

const rootArg = process.argv[2]
if (!rootArg) {
  console.error('usage: npx tsx scripts/smoke-pack.ts <root>')
  process.exit(1)
}
const root = resolve(rootArg)
const paths = resolvePaths(root)
const instanceDir = paths.instance(INSTANCE_ID)
const statePath = join(paths.state, `sync-${INSTANCE_ID}.json`)

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`)
}

function report(e: ProgressEvent): void {
  const progress = e.current !== undefined && e.total !== undefined ? ` (${e.current}/${e.total} ${e.unit ?? ''})` : ''
  console.log(`  [${e.phase}] ${e.message}${progress}`)
}

const log = (line: string): void => console.log(`  log: ${line}`)

type Resolver = (options: PackOption[]) => Record<string, boolean>

async function run(label: string, resolveOptions?: Resolver): Promise<{ result: SyncResult; ms: number }> {
  console.log(`\n== ${label}`)
  const started = Date.now()
  const result = await syncPack({ paths, instanceId: INSTANCE_ID, baseUrl: PACK_BASE_URL, side: 'client', report, resolveOptions, log })
  const ms = Date.now() - started
  console.log(
    `  result: downloaded=${result.downloaded} deleted=${result.deleted} skipped=${result.skipped} unchanged=${result.unchanged} files=${result.pack.files} options=${result.options.length} (${ms} ms)`,
  )
  return { result, ms }
}

interface StateShape {
  packHash: string
  indexHash: string
  options: Record<string, boolean>
  optionList: PackOption[]
  files: Record<string, { hash: string; hashFormat: string; source?: string }>
}

async function readState(): Promise<StateShape> {
  return JSON.parse(await readFile(statePath, 'utf8')) as StateShape
}

function onDisk(relPath: string): string {
  return join(instanceDir, ...relPath.split('/'))
}

/** Resolves with the rejection so a check can inspect it (undefined when the promise succeeded). */
function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (err: unknown) => err,
  )
}

function describeFailure(err: unknown): string {
  if (err === undefined) return 'no error at all'
  return err instanceof DownloadError ? `${err.reason}: ${err.message}` : String(err)
}

/**
 * download.ts policy checks that syncPack alone cannot exercise: a redirect to a host outside the
 * allow-list must be refused, and a local disk failure must be reported once, readably, without
 * the network retry backoff.
 */
async function checkDownloadPolicy(): Promise<void> {
  console.log('\n== download policy')

  // github.com is allowed but this URL redirects to codeload.github.com, which is not.
  const archiveUrl = 'https://github.com/underfr/consortium-pack/archive/refs/heads/main.zip'
  const redirect = await failureOf(fetchBytes(archiveUrl))
  check(redirect instanceof DownloadError && redirect.reason === 'policy', `redirect off the allow-list must be refused, got ${describeFailure(redirect)}`)
  console.log(`  refused: ${describeFailure(redirect)}`)

  // The parent of dest exists as a file: mkdir fails before any request is made.
  const scratch = join(root, 'policy-scratch')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  const blocker = join(scratch, 'mods')
  await writeFile(blocker, 'a file where a folder is expected\n')
  const mkdirFailure = await failureOf(ensureFile({ url: PACK_BASE_URL + 'index.toml', dest: join(blocker, 'index.toml'), log }))
  check(mkdirFailure instanceof DownloadError && mkdirFailure.reason === 'disk', `parent-is-a-file must be a disk error, got ${describeFailure(mkdirFailure)}`)
  console.log(`  disk (mkdir): ${describeFailure(mkdirFailure)}`)

  // dest + '.part' is a directory: the write fails mid-download and must not be retried 3 times.
  const dest = join(scratch, 'index.toml')
  await mkdir(dest + '.part', { recursive: true })
  const started = Date.now()
  const writeFailure = await failureOf(ensureFile({ url: PACK_BASE_URL + 'index.toml', dest, log }))
  const ms = Date.now() - started
  check(writeFailure instanceof DownloadError && writeFailure.reason === 'disk', `unwritable .part must be a disk error, got ${describeFailure(writeFailure)}`)
  check(ms < 5000, `a disk error must fail fast (no network backoff), took ${ms} ms`)
  console.log(`  disk (write): ${describeFailure(writeFailure)} (${ms} ms)`)
  await rm(scratch, { recursive: true, force: true })
}

/**
 * Optional entries through the resolver the Play handler uses (effectiveOptions). Iris is the
 * optional entry the pack has carried since 0.5.0 and its default is off, so the steady state
 * has no Iris jar. The jar name is never hard-coded: it comes from the state entry whose source
 * is the Iris metafile, so a version bump of Iris in the pack leaves this test green.
 */
async function checkOptionalEntries(steady: SyncResult, launcher: OptionRules): Promise<SyncResult> {
  console.log('\n== optional entries')
  console.log(`  options: ${steady.options.map((o) => `${o.file} (default ${o.default})`).join(', ') || 'none'}`)
  const iris = steady.options.find((o) => o.file.endsWith('/iris.pw.toml'))
  check(iris !== undefined, 'the pack must list Iris as an optional entry')
  if (iris === undefined) return steady
  check(!iris.default, 'Iris must be off by default in the pack')
  check(typeof iris.description === 'string' && iris.description.length > 0, 'the Iris [option] description must be parsed')
  check(iris.side === 'client', 'Iris must be a client-side entry')
  const cached = await readPackOptions(paths, INSTANCE_ID, PACK_BASE_URL, 'client', { log })
  check(JSON.stringify(cached) === JSON.stringify(steady.options), 'readPackOptions must return the cached list of the last full pass')
  const before = await readState()
  check(!Object.values(before.files).some((f) => f.source === iris.file), 'no Iris jar may be installed while the option is off')
  // The low preset rule of the live launcher.json when it names Iris, else the rule the pack will publish.
  const rules: OptionRules = launcher.lowPresetDisables.includes(iris.file) ? launcher : { lowPresetDisables: [iris.file], optionRequires: {} }

  const choice: Settings = { preset: 'default', options: { [iris.file]: true } }
  const seventh = await run('run 7: iris enabled (default preset)', (list) => effectiveOptions(choice, list, rules, log))
  check(!seventh.result.unchanged, 'run 7 must do a full pass (the choice changed)')
  check(seventh.result.downloaded === 1, `run 7 must download exactly one file (the Iris jar), got ${seventh.result.downloaded}`)
  const enabled = await readState()
  const irisJar = Object.entries(enabled.files).find(([, f]) => f.source === iris.file)?.[0]
  check(irisJar !== undefined, 'the state must record a file whose source is the Iris metafile')
  if (irisJar === undefined) return seventh.result
  console.log(`  iris jar: ${irisJar}`)
  check(existsSync(onDisk(irisJar)), `${irisJar} must be on disk after run 7`)
  check(enabled.options[iris.file] === true, 'the state must record the Iris choice as true')
  check(enabled.optionList.some((o) => o.file === iris.file), 'the state must cache the option list')

  const low: Settings = { preset: 'low', options: { [iris.file]: true } }
  const eighth = await run('run 8: low preset forces iris off', (list) => effectiveOptions(low, list, rules, log))
  check(!eighth.result.unchanged, 'run 8 must do a full pass (the effective choice changed)')
  check(eighth.result.deleted === 1, `run 8 must remove exactly one file (the Iris jar), got ${eighth.result.deleted}`)
  check(!existsSync(onDisk(irisJar)), `${irisJar} must be gone after run 8`)
  const forced = await readState()
  check(forced.options[iris.file] === false, 'the state must record the effective (forced off) value')
  check(!(irisJar in forced.files), 'the state must no longer list the Iris jar')

  const ninth = await run('run 9: low preset steady state', (list) => effectiveOptions(low, list, rules, log))
  check(ninth.result.unchanged, 'run 9 must short-circuit through the cached option list')
  check(ninth.result.options.some((o) => o.file === iris.file), 'the short-circuit result must carry the cached option list')
  return ninth.result
}

async function main(): Promise<void> {
  console.log(`root: ${root}`)
  await rm(instanceDir, { recursive: true, force: true })
  await rm(statePath, { force: true })
  await mkdir(instanceDir, { recursive: true })

  // Files a sync must never touch: they share the instance directory with the pack.
  const survivors = [join(instanceDir, 'saves', 'My World', 'level.dat'), join(instanceDir, 'options.txt'), join(instanceDir, 'screenshots', 'shot.png')]
  for (const file of survivors) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, 'keep me\n')
  }

  console.log('\n== readPackVersions / readLauncherJson')
  const versions = await readPackVersions(PACK_BASE_URL)
  console.log(`  versions: ${JSON.stringify(versions)}`)
  check(versions.minecraft === '1.21.1', `expected minecraft 1.21.1, got ${versions.minecraft}`)
  check(/^\d+\.\d+\.\d+$/.test(versions.neoforge), `neoforge version looks wrong: ${versions.neoforge}`)
  const launcher = await readLauncherJson(PACK_BASE_URL)
  console.log(`  launcher.json: ${JSON.stringify(launcher)}`)
  check(launcher.schemaVersion === 1 && typeof launcher.server.name === 'string', 'launcher.json shape')
  check(Array.isArray(launcher.lowPresetDisables) && typeof launcher.optionRequires === 'object', 'launcher.json option rules default to empty')

  // Before any state exists, the option reader falls back to fetching the metafiles.
  const fetched = await readPackOptions(paths, INSTANCE_ID, PACK_BASE_URL, 'client', { log })
  console.log(`  readPackOptions (no state): ${fetched.map((o) => o.file).join(', ') || 'none'}`)

  const first = await run('run 1: fresh install')
  check(!first.result.unchanged, 'run 1 must not be reported as unchanged')
  check(first.result.pack.files > 0, 'the pack must list at least one file')
  check(first.result.downloaded === first.result.pack.files, `run 1 must download every file (${first.result.downloaded}/${first.result.pack.files})`)
  check(first.result.pack.minecraft === versions.minecraft, 'pack info versions must match readPackVersions')
  check(JSON.stringify(first.result.options) === JSON.stringify(fetched), 'the option list of the full pass must match the pre-sync reader')
  const state = await readState()
  const files = Object.keys(state.files)
  check(files.length === first.result.pack.files, `state must record ${first.result.pack.files} files, has ${files.length}`)
  for (const relPath of files) check(existsSync(onDisk(relPath)), `${relPath} must exist after run 1`)
  console.log(`  state files: ${files.join(', ')}`)

  const second = await run('run 2: nothing changed')
  check(second.result.unchanged, 'run 2 must report unchanged=true')
  check(second.result.downloaded === 0 && second.result.deleted === 0, 'run 2 must not download or delete')
  check(second.ms < 2000, `run 2 must take < 2 s, took ${second.ms} ms`)

  const victim = files.find((f) => f.endsWith('.jar')) ?? files[0]
  check(victim !== undefined, 'need at least one file to delete')
  if (victim === undefined) return
  await rm(onDisk(victim))
  const third = await run(`run 3: ${victim} deleted from disk`)
  check(!third.result.unchanged, 'run 3 must do a full pass')
  check(third.result.downloaded === 1, `run 3 must re-download exactly one file, got ${third.result.downloaded}`)
  check(existsSync(onDisk(victim)), `${victim} must be back on disk`)

  // Damaged state: drop one entry, the sync must notice the state no longer covers the index.
  const damaged = await readState()
  const dropped = files[files.length - 1]
  check(dropped !== undefined, 'need an entry to drop')
  if (dropped === undefined) return
  delete damaged.files[dropped]
  await writeFile(statePath, JSON.stringify(damaged, null, 2))
  const fourth = await run(`run 4: state entry ${dropped} removed`)
  check(!fourth.result.unchanged, 'run 4 must re-verify instead of short-circuiting')
  check(fourth.result.downloaded === 0, `run 4 must find every file valid, downloaded ${fourth.result.downloaded}`)
  const repaired = await readState()
  check(dropped in repaired.files, `state must list ${dropped} again after run 4`)

  // Delete-on-vanish: a file recorded in the state but absent from the index is removed...
  const stale = 'mods/old-mod-from-last-season.jar'
  await writeFile(onDisk(stale), 'stale jar\n')
  const withStale = await readState()
  withStale.files[stale] = { hash: 'deadbeef', hashFormat: 'sha1' }
  await writeFile(statePath, JSON.stringify(withStale, null, 2))
  // ...while a stray file the launcher never installed is left alone.
  const stray = onDisk('mods/manually-added.jar')
  await writeFile(stray, 'player added this\n')
  const fifth = await run(`run 5: ${stale} left the pack`)
  check(fifth.result.deleted === 1, `run 5 must delete exactly one file, deleted ${fifth.result.deleted}`)
  check(!existsSync(onDisk(stale)), `${stale} must be gone`)
  check(existsSync(stray), 'a file not recorded in the state must never be deleted')
  await rm(stray)

  // A state written by a launcher before 0.3.0 has no option list: it must force one full pass.
  const withoutList: Record<string, unknown> = { ...(await readState()) }
  delete withoutList['optionList']
  await writeFile(statePath, JSON.stringify(withoutList, null, 2))
  const legacyRun = await run('run 5b: state without option list (pre-0.3.0)')
  check(!legacyRun.result.unchanged, 'run 5b must do a full pass to rebuild the option list')
  check(legacyRun.result.downloaded === 0 && legacyRun.result.deleted === 0, 'run 5b must neither download nor delete')
  check(Array.isArray((await readState()).optionList), 'run 5b must write the option list back')

  const sixth = await run('run 6: back to steady state')
  check(sixth.result.unchanged, 'run 6 must report unchanged=true')

  const last = await checkOptionalEntries(sixth.result, launcher)

  for (const file of survivors) check(existsSync(file), `${file} must survive every sync`)
  for (const relPath of Object.keys((await readState()).files)) check(existsSync(onDisk(relPath)), `${relPath} must exist at the end`)

  await checkDownloadPolicy()

  console.log(`\nOK: ${last.pack.files} files`)
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.stack ?? err.message : String(err))
  if (err instanceof Error && err.cause !== undefined) console.error('cause:', err.cause)
  process.exit(1)
})
