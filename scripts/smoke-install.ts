// Smoke test for java.ts, vanilla.ts and neoforge.ts against the real network.
//
//   npx tsx scripts/smoke-install.ts <root> [--fresh]
//
// Pass 1 installs everything (cold when --fresh wipes <root> first, or when it does not exist
// yet). Pass 2 runs the same three ensure* calls again and must finish in under 3 s without
// downloading anything. Pass 3 breaks the install the way an interrupted run would (a NeoForge
// runtime jar deleted, an asset with a zero-filled hole at its full size plus no completion
// marker) and checks that both come back. The root is left in place so smoke-launch.ts can
// reuse it.

import { createHash } from 'node:crypto'
import { access, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MinecraftFolder, Version } from '@xmcl/core'
import type { ProgressEvent } from '../src/shared/types'
import { ensureJava } from '../src/main/core/java'
import { ensureNeoForge } from '../src/main/core/neoforge'
import { resolvePaths } from '../src/main/core/paths'
import { ASSETS_VERIFIED_MARKER, ensureVanilla } from '../src/main/core/vanilla'

const MC_VERSION = '1.21.1'
const NEO_VERSION = '21.1.250'
const WARM_BUDGET_MS = 3000
/** Files above this size are downloaded as parallel byte ranges by @xmcl/file-transfer. */
const RANGE_THRESHOLD = 2 * 1024 * 1024

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const fresh = args.includes('--fresh')
  const root = args.find((a) => !a.startsWith('--'))
  if (!root) {
    console.error('usage: npx tsx scripts/smoke-install.ts <root> [--fresh]')
    process.exit(1)
  }
  if (fresh) {
    console.log(`wiping ${root}`)
    await rm(root, { recursive: true, force: true })
  }
  const paths = resolvePaths(root)
  const folder = MinecraftFolder.from(paths.minecraft)
  console.log(`root: ${root}`)
  const failures: string[] = []

  // ---- pass 1: install ----------------------------------------------------------------
  console.log('\n=== pass 1: install ===')
  const cold = makeReporter('pass1')
  const t0 = Date.now()
  const java = await ensureJava(paths, cold.report, { log: cold.log })
  const tJava = Date.now()
  console.log(`java phase: ${seconds(tJava - t0)} s (${java.version} at ${java.javaPath})`)

  const vanilla = await ensureVanilla(paths, MC_VERSION, cold.report, { log: cold.log })
  const tVanilla = Date.now()
  console.log(`minecraft phase: ${seconds(tVanilla - tJava)} s (${vanilla.id}, ${vanilla.libraries.length} libraries)`)

  const versionId = await ensureNeoForge(paths, MC_VERSION, NEO_VERSION, java.javaPath, cold.report, { log: cold.log })
  const tNeo = Date.now()
  console.log(`neoforge phase: ${seconds(tNeo - tVanilla)} s (${versionId})`)
  console.log(`pass 1 total: ${seconds(tNeo - t0)} s`)

  // ---- pass 2: everything cached --------------------------------------------------------
  console.log('\n=== pass 2: warm re-run (must be < 3 s, no downloads) ===')
  const warm = makeReporter('pass2')
  const w0 = Date.now()
  const java2 = await ensureJava(paths, warm.report, { log: warm.log })
  const w1 = Date.now()
  await ensureVanilla(paths, MC_VERSION, warm.report, { log: warm.log })
  const w2 = Date.now()
  const versionId2 = await ensureNeoForge(paths, MC_VERSION, NEO_VERSION, java2.javaPath, warm.report, { log: warm.log })
  const w3 = Date.now()
  console.log(`warm: java ${w1 - w0} ms, minecraft ${w2 - w1} ms, neoforge ${w3 - w2} ms, total ${w3 - w0} ms`)

  if (w3 - w0 >= WARM_BUDGET_MS) failures.push(`warm pass took ${w3 - w0} ms, budget is ${WARM_BUDGET_MS} ms`)
  for (const phase of ['java', 'minecraft', 'neoforge']) {
    if (!warm.lines.some((l) => l.startsWith(`${phase}:`) && l.includes('cached'))) {
      failures.push(`warm pass: no "cached" log line from ${phase}`)
    }
  }
  if (w3 - w2 >= 50) failures.push(`warm neoforge gate took ${w3 - w2} ms, must be < 50 ms`)
  if (versionId !== `neoforge-${NEO_VERSION}` || versionId2 !== versionId) {
    failures.push(`unexpected version id ${versionId} / ${versionId2}`)
  }
  const marker = join(folder.getVersionRoot(MC_VERSION), ASSETS_VERIFIED_MARKER)
  if (!(await exists(marker))) failures.push(`missing assets marker after the warm pass: ${marker}`)

  // ---- pass 3: repair after an interrupted run ------------------------------------------
  console.log('\n=== pass 3: repair (one NeoForge runtime jar deleted, one asset corrupted) ===')
  const resolved = await Version.parse(folder, versionId)

  // The NeoForge installer fetches these jars as its very last step, so this is exactly what
  // a run killed during that step leaves behind: every gate file present, the loader absent.
  const loader = resolved.libraries.find((l) => l.groupId === 'net.neoforged.fancymodloader' && l.artifactId === 'loader')
  if (!loader) {
    failures.push('resolved version has no net.neoforged.fancymodloader:loader library')
  } else {
    const loaderJar = folder.getLibraryByPath(loader.download.path)
    await rm(loaderJar, { force: true })
    console.log(`deleted ${loaderJar}`)
    const repair = makeReporter('pass3')
    const r0 = Date.now()
    const versionId3 = await ensureNeoForge(paths, MC_VERSION, NEO_VERSION, java2.javaPath, repair.report, { log: repair.log })
    console.log(`neoforge repair: ${seconds(Date.now() - r0)} s (${versionId3})`)
    if (versionId3 !== versionId) failures.push(`repair pass: unexpected version id ${versionId3}`)
    if (repair.lines.some((l) => l.startsWith('neoforge:') && l.includes('cached'))) {
      failures.push('repair pass: neoforge reported "cached" with a runtime jar missing')
    }
    if (!repair.lines.some((l) => l.startsWith('neoforge:') && l.includes('missing 1 library file'))) {
      failures.push('repair pass: neoforge did not report the missing library')
    }
    const sha1 = await sha1Of(loaderJar)
    if (sha1 !== loader.download.sha1) {
      failures.push(`repair pass: ${loaderJar} is ${sha1 ?? 'still missing'}, expected sha1 ${loader.download.sha1}`)
    } else {
      console.log(`ok      ${loaderJar} is back (sha1 ${sha1})`)
    }
  }

  // A ranged download killed halfway leaves the asset at its final size with zero-filled
  // holes and no completion marker; the next run must hash everything and re-fetch it.
  const asset = await smallestRangedAsset(folder, vanilla.assets)
  if (!asset) {
    failures.push(`no asset above ${RANGE_THRESHOLD} bytes in asset index ${vanilla.assets}`)
  } else {
    const assetFile = folder.getAsset(asset.hash)
    await zeroFill(assetFile, Math.floor(asset.size / 2), 65_536)
    await rm(marker, { force: true })
    console.log(`zero-filled 64 KB inside ${assetFile} (${asset.name}, ${asset.size} bytes) and removed the marker`)
    const repair = makeReporter('pass3')
    const r0 = Date.now()
    await ensureVanilla(paths, MC_VERSION, repair.report, { log: repair.log })
    console.log(`minecraft repair: ${seconds(Date.now() - r0)} s`)
    if (!repair.lines.some((l) => l.startsWith('minecraft:') && l.includes('downloaded'))) {
      failures.push('repair pass: minecraft did not re-download the corrupted asset')
    }
    const sha1 = await sha1Of(assetFile)
    if (sha1 !== asset.hash) failures.push(`repair pass: ${assetFile} has sha1 ${sha1 ?? 'missing'}, expected ${asset.hash}`)
    else console.log(`ok      ${assetFile} is back (sha1 ${sha1})`)
    if (!(await exists(marker))) failures.push(`repair pass: assets marker was not rewritten: ${marker}`)
    if ((await stat(assetFile)).size !== asset.size) failures.push(`repair pass: ${assetFile} has the wrong size`)
  }

  // ---- artifacts the launcher will need ---------------------------------------------------
  console.log('\n=== artifacts ===')
  const neoForm = neoFormOf(resolved.arguments.game)
  console.log(`resolved ${resolved.id}: mainClass ${resolved.mainClass}, inherits ${resolved.inheritances.join(' -> ')}, ${resolved.libraries.length} libraries, neoform ${neoForm ?? 'unknown'}`)
  const required = [
    java.javaPath,
    join(paths.java, '.verified'),
    folder.getVersionJson(MC_VERSION),
    folder.getVersionJar(MC_VERSION),
    marker,
    folder.getVersionJson(versionId),
    join(folder.libraries, 'net', 'neoforged', 'neoforge', NEO_VERSION, `neoforge-${NEO_VERSION}-client.jar`),
    join(folder.libraries, 'net', 'neoforged', 'neoforge', NEO_VERSION, `neoforge-${NEO_VERSION}-universal.jar`),
  ]
  if (neoForm) {
    const clientDir = join(folder.libraries, 'net', 'minecraft', 'client', `${MC_VERSION}-${neoForm}`)
    required.push(join(clientDir, `client-${MC_VERSION}-${neoForm}-srg.jar`), join(clientDir, `client-${MC_VERSION}-${neoForm}-extra.jar`))
  } else {
    failures.push('could not read --fml.neoFormVersion from the resolved version')
  }
  for (const file of required) {
    const ok = await exists(file)
    console.log(`${ok ? 'ok     ' : 'MISSING'} ${file}`)
    if (!ok) failures.push(`missing ${file}`)
  }
  let missingLibraries = 0
  for (const lib of resolved.libraries) {
    if (!(await exists(folder.getLibraryByPath(lib.download.path)))) {
      missingLibraries++
      console.log(`MISSING ${folder.getLibraryByPath(lib.download.path)}`)
    }
  }
  console.log(`${missingLibraries === 0 ? 'ok     ' : 'MISSING'} ${resolved.libraries.length} libraries of ${versionId} (${missingLibraries} missing)`)
  if (missingLibraries > 0) failures.push(`${missingLibraries} libraries of ${versionId} are missing`)

  if (failures.length > 0) {
    console.error('\nFAILED:')
    for (const f of failures) console.error(' - ' + f)
    process.exit(1)
  }
  console.log(`\nOK: ${versionId} ready`)
}

interface Reporter {
  report: (e: ProgressEvent) => void
  log: (line: string) => void
  lines: string[]
}

/** Prints module log lines verbatim and progress at most once per second per message
 *  (plus the first 100% of each message), prefixed with seconds since the pass started. */
function makeReporter(tag: string): Reporter {
  const lines: string[] = []
  const started = Date.now()
  const stamp = (): string => `[${tag} +${seconds(Date.now() - started).padStart(5)}s]`
  let lastMessage = ''
  let lastPrint = 0
  let doneShown = false
  return {
    lines,
    log: (line) => {
      lines.push(line)
      console.log(`  ${stamp()} ${line}`)
    },
    report: (e) => {
      const now = Date.now()
      if (e.message !== lastMessage) doneShown = false
      const done = e.total !== undefined && e.current !== undefined && e.total > 0 && e.current >= e.total
      const firstDone = done && !doneShown
      if (e.message === lastMessage && now - lastPrint < 1000 && !firstDone) return
      if (done) doneShown = true
      lastMessage = e.message
      lastPrint = now
      const detail =
        e.current !== undefined && e.total !== undefined
          ? e.unit === 'bytes'
            ? ` ${(e.current / 1_048_576).toFixed(1)} / ${(e.total / 1_048_576).toFixed(1)} MB`
            : ` ${e.current} / ${e.total} ${e.unit ?? ''}`
          : ''
      console.log(`  ${stamp()} ${e.phase}: ${e.message}${detail}`)
    },
  }
}

interface AssetEntry {
  name: string
  hash: string
  size: number
}

/** The smallest asset that @xmcl/file-transfer fetches as byte ranges (cheapest to re-download). */
async function smallestRangedAsset(folder: MinecraftFolder, indexId: string): Promise<AssetEntry | null> {
  const index = JSON.parse(await readFile(folder.getAssetsIndex(indexId), 'utf8')) as {
    objects: Record<string, { hash: string; size: number }>
  }
  let best: AssetEntry | null = null
  for (const [name, { hash, size }] of Object.entries(index.objects)) {
    if (size > RANGE_THRESHOLD && (!best || size < best.size)) best = { name, hash, size }
  }
  return best
}

/** Overwrites `length` bytes at `position` with zeros, keeping the file size unchanged. */
async function zeroFill(file: string, position: number, length: number): Promise<void> {
  const handle = await open(file, 'r+')
  try {
    await handle.write(Buffer.alloc(length), 0, length, position)
  } finally {
    await handle.close()
  }
}

/** Hex sha1 of a file, or null when it does not exist. */
async function sha1Of(file: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(file)).digest('hex')
  } catch {
    return null
  }
}

function neoFormOf(game: (string | { value: string | string[] })[]): string | null {
  const flat = game.flatMap((a) => (typeof a === 'string' ? [a] : a.value))
  const at = flat.indexOf('--fml.neoFormVersion')
  return at >= 0 && at + 1 < flat.length ? flat[at + 1] : null
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

main().catch((err: unknown) => {
  console.error('\nFAILED: ' + (err instanceof Error ? err.stack ?? err.message : String(err)))
  process.exit(1)
})
