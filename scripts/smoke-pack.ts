// Smoke test for src/main/core/pack.ts against the live test pack.
//
//   npx tsx scripts/smoke-pack.ts <root>
//
// The instance "consortium" and its sync state under <root> are reset at the start so every
// run exercises the fresh-install path. Exits 1 on the first failed check.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { INSTANCE_ID, PACK_BASE_URL } from '../src/main/core/config'
import { DownloadError, ensureFile, fetchBytes } from '../src/main/core/download'
import { resolvePaths } from '../src/main/core/paths'
import { readLauncherJson, readPackVersions, syncPack } from '../src/main/core/pack'
import type { ProgressEvent, SyncResult } from '../src/shared/types'

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

async function run(label: string): Promise<{ result: SyncResult; ms: number }> {
  console.log(`\n== ${label}`)
  const started = Date.now()
  const result = await syncPack({ paths, instanceId: INSTANCE_ID, baseUrl: PACK_BASE_URL, side: 'client', report, log })
  const ms = Date.now() - started
  console.log(
    `  result: downloaded=${result.downloaded} deleted=${result.deleted} skipped=${result.skipped} unchanged=${result.unchanged} files=${result.pack.files} (${ms} ms)`,
  )
  return { result, ms }
}

interface StateShape {
  packHash: string
  indexHash: string
  files: Record<string, { hash: string; hashFormat: string }>
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

  const first = await run('run 1: fresh install')
  check(!first.result.unchanged, 'run 1 must not be reported as unchanged')
  check(first.result.pack.files > 0, 'the pack must list at least one file')
  check(first.result.downloaded === first.result.pack.files, `run 1 must download every file (${first.result.downloaded}/${first.result.pack.files})`)
  check(first.result.pack.minecraft === versions.minecraft, 'pack info versions must match readPackVersions')
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

  const sixth = await run('run 6: back to steady state')
  check(sixth.result.unchanged, 'run 6 must report unchanged=true')

  for (const file of survivors) check(existsSync(file), `${file} must survive every sync`)
  for (const relPath of Object.keys((await readState()).files)) check(existsSync(onDisk(relPath)), `${relPath} must exist at the end`)

  await checkDownloadPolicy()

  console.log(`\nOK: ${sixth.result.pack.files} files`)
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.stack ?? err.message : String(err))
  if (err instanceof Error && err.cause !== undefined) console.error('cause:', err.cause)
  process.exit(1)
})
