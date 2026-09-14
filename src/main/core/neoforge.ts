// NeoForge on top of the vanilla install: versions/neoforge-<v>/ plus the patched client jars
// the NeoForge installer produces under libraries/. Running the installer costs ~30 s and a
// 9.6 MB mappings download, so it only ever runs when one of its outputs is missing. The
// loader's runtime libraries are checked separately on every call (see ensureNeoForge) and
// repaired with a plain library download, never with a full installer run.

import { spawn } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MinecraftFolder, Version, type ResolvedVersion } from '@xmcl/core'
import { installLibrariesTask, installNeoForgedTask } from '@xmcl/installer'
import type { ProgressReporter } from '../../shared/types'
import { createTaskProgress, describeError, libraryHeaders, withRetries } from './java'
import type { LauncherPaths } from './paths'

export class NeoForgeError extends Error {
  override name = 'NeoForgeError'
}

/**
 * Returns the version id `neoforge-<neoVersion>`. Gate: versions/<id>/<id>.json and the four
 * runtime artifacts (client-<mc>-<neoform>-srg.jar, -extra.jar, neoforge-<v>-client.jar,
 * -universal.jar) exist, and every library of the resolved version is on disk with its
 * expected size; then it returns in a few milliseconds without touching the network.
 * Otherwise installNeoForgedTask downloads the installer and runs its processors with javaPath,
 * or, when only libraries are missing, they are fetched directly.
 */
export async function ensureNeoForge(
  paths: LauncherPaths,
  mcVersion: string,
  neoVersion: string,
  javaPath: string,
  report: ProgressReporter,
  opts: { log?: (line: string) => void } = {},
): Promise<string> {
  const log = opts.log ?? console.log
  const versionId = `neoforge-${neoVersion}`
  const folder = MinecraftFolder.from(paths.minecraft)
  report({ phase: 'neoforge', message: `Checking NeoForge ${neoVersion}` })

  const started = Date.now()
  let transferredBytes = 0
  const missing = await missingArtifacts(folder, mcVersion, neoVersion, versionId)
  // A version json that exists but cannot be parsed is repaired the same way: the installer
  // rewrites it unconditionally.
  let resolved = missing.length === 0 ? await tryParseVersion(folder, versionId) : null
  const needsInstaller = resolved === null
  if (resolved === null) {
    if (missing.length > 0) {
      log(`neoforge: installing ${versionId}, missing ${missing.length} file(s): ${missing.join(', ')}`)
    } else {
      log(`neoforge: installing ${versionId}, its version file cannot be read`)
    }
    transferredBytes += await runInstaller(folder, mcVersion, neoVersion, versionId, javaPath, report, log)
    const stillMissing = await missingArtifacts(folder, mcVersion, neoVersion, versionId)
    if (stillMissing.length > 0) {
      throw new NeoForgeError(
        `NeoForge ${neoVersion} finished installing but these files are missing: ${stillMissing.join(', ')}. Try again; if it keeps failing, delete ${paths.minecraft}.`,
      )
    }
    resolved = await parseVersion(folder, versionId)
  }

  // The installer fetches the loader's runtime libraries as its very last step, so a run that
  // failed or was closed during that step leaves every gate file above in place. Nothing else
  // in the pipeline validates these jars (ensureVanilla only covers the vanilla ones), hence
  // this check on every call: one stat per library, a few milliseconds.
  const missingLibraries = await missingLibraryFiles(folder, resolved)
  if (missingLibraries.length > 0) {
    log(`neoforge: ${versionId} is missing ${missingLibraries.length} library file(s), for example ${missingLibraries[0]}`)
    transferredBytes += await downloadLibraries(resolved, neoVersion, report, log)
    const stillMissing = await missingLibraryFiles(folder, resolved)
    if (stillMissing.length > 0) {
      throw new NeoForgeError(
        `NeoForge ${neoVersion} is still missing ${stillMissing.length} library file(s), for example ${stillMissing[0]}. Try again; if it keeps failing, delete ${paths.minecraft}.`,
      )
    }
  } else if (!needsInstaller) {
    log(`neoforge: cached ${versionId} (checked in ${Date.now() - started} ms)`)
    return versionId
  }

  log(`neoforge: ${versionId} ready (${((Date.now() - started) / 1000).toFixed(1)} s, ${(transferredBytes / 1_048_576).toFixed(1)} MB downloaded)`)
  return versionId
}

/** Runs the NeoForge installer (download, unpack, processors, libraries). Returns bytes downloaded. */
async function runInstaller(
  folder: MinecraftFolder,
  mcVersion: string,
  neoVersion: string,
  versionId: string,
  javaPath: string,
  report: ProgressReporter,
  log: (line: string) => void,
): Promise<number> {
  // The installer patches the vanilla client jar, so it must be there first.
  if (!(await exists(folder.getVersionJar(mcVersion)))) {
    throw new NeoForgeError(`Minecraft ${mcVersion} is not installed yet, so NeoForge cannot be set up. Try again.`)
  }

  const progress = createTaskProgress('neoforge', report, [
    { path: 'installForge.downloadInstaller', message: `Downloading NeoForge ${neoVersion}`, unit: 'bytes' },
    { path: 'installForge.library', message: 'Downloading NeoForge libraries', unit: 'bytes' },
    { path: 'installForge.postProcessing', message: 'Setting up NeoForge', unit: 'files' },
  ])
  report({ phase: 'neoforge', message: `Downloading NeoForge ${neoVersion}` })
  let installedId: string
  try {
    installedId = await withRetries('neoforge', log, () =>
      installNeoForgedTask('neoforge', neoVersion, folder, {
        java: javaPath,
        inheritsFrom: mcVersion,
        headers: libraryHeaders(),
        // The library spawns each processor JVM itself; without windowsHide every one of the
        // six would flash a console window on the player's screen.
        spawn: (command, args, options) => spawn(command, args ?? [], { ...options, windowsHide: true }),
        onPostProcessFailed: (_proc, jar, _cp, mainClass, args, error) =>
          log(`neoforge: processor ${mainClass} (${jar}) failed with args ${args.join(' ')}: ${describeError(error)}`),
      }).startAndWait(progress.context),
    )
  } catch (err) {
    throw new NeoForgeError(
      `Installing NeoForge ${neoVersion} failed: ${describeError(err)}. Check your internet connection and try again.`,
    )
  }
  if (installedId !== versionId) {
    log(`neoforge: warning, the installer produced version id ${installedId} instead of ${versionId}`)
  }
  return progress.stats.transferredBytes
}

/** Fetches whatever libraries of the resolved version are missing or invalid (the library
 *  re-validates existing files by sha1 and skips them). Returns bytes downloaded. */
async function downloadLibraries(
  resolved: ResolvedVersion,
  neoVersion: string,
  report: ProgressReporter,
  log: (line: string) => void,
): Promise<number> {
  // Run on its own the task's path is just its name, "libraries".
  const progress = createTaskProgress('neoforge', report, [
    { path: 'libraries', message: 'Downloading NeoForge libraries', unit: 'bytes' },
  ])
  report({ phase: 'neoforge', message: 'Downloading NeoForge libraries' })
  try {
    await withRetries('neoforge', log, () =>
      installLibrariesTask(resolved, { headers: libraryHeaders() }).startAndWait(progress.context),
    )
  } catch (err) {
    throw new NeoForgeError(
      `Downloading the NeoForge ${neoVersion} libraries failed: ${describeError(err)}. Check your internet connection and try again.`,
    )
  }
  return progress.stats.transferredBytes
}

/** Paths of the gate files that are absent. Empty means the installer has run to its last step. */
async function missingArtifacts(
  folder: MinecraftFolder,
  mcVersion: string,
  neoVersion: string,
  versionId: string,
): Promise<string[]> {
  const missing: string[] = []
  const jsonPath = folder.getVersionJson(versionId)
  let neoForm: string | null = null
  if (await exists(jsonPath)) neoForm = await neoFormFromJson(jsonPath)
  else missing.push(jsonPath)
  if (!neoForm) neoForm = await neoFormFromLibraries(folder, mcVersion)

  const neoDir = join(folder.libraries, 'net', 'neoforged', 'neoforge', neoVersion)
  const wanted = [join(neoDir, `neoforge-${neoVersion}-client.jar`), join(neoDir, `neoforge-${neoVersion}-universal.jar`)]
  if (neoForm) {
    const clientDir = join(folder.libraries, 'net', 'minecraft', 'client', `${mcVersion}-${neoForm}`)
    wanted.push(
      join(clientDir, `client-${mcVersion}-${neoForm}-srg.jar`),
      join(clientDir, `client-${mcVersion}-${neoForm}-extra.jar`),
    )
  } else {
    missing.push(join(folder.libraries, 'net', 'minecraft', 'client', `${mcVersion}-<neoform>`) + ' (NeoForm version unknown)')
  }
  for (const file of wanted) {
    if (!(await exists(file))) missing.push(file)
  }
  return missing
}

/** Library files of the resolved version (NeoForge and vanilla alike) that are absent or do
 *  not have the size the version json announces; a half-written jar counts as missing. */
async function missingLibraryFiles(folder: MinecraftFolder, resolved: ResolvedVersion): Promise<string[]> {
  const checks = resolved.libraries.map(async (lib) => {
    const file = folder.getLibraryByPath(lib.download.path)
    try {
      const info = await stat(file)
      const expected = lib.download.size
      return expected > 0 && info.size !== expected ? file : null
    } catch {
      return file
    }
  })
  return (await Promise.all(checks)).filter((file): file is string => file !== null)
}

/** Version.parse, or null when the version files cannot be read (the installer will rewrite them). */
async function tryParseVersion(folder: MinecraftFolder, versionId: string): Promise<ResolvedVersion | null> {
  try {
    return await Version.parse(folder, versionId)
  } catch {
    return null
  }
}

async function parseVersion(folder: MinecraftFolder, versionId: string): Promise<ResolvedVersion> {
  try {
    return await Version.parse(folder, versionId)
  } catch (err) {
    // Version.parse rejects with plain objects ({ error: 'MissingVersionJson', ... }), not Errors.
    const why = err instanceof Error ? err.message : JSON.stringify(err)
    throw new NeoForgeError(`NeoForge ${versionId} is installed but its version file cannot be read: ${why}. Try again.`)
  }
}

/** The value following "--fml.neoFormVersion" in the version json's game arguments. */
async function neoFormFromJson(jsonPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as { arguments?: { game?: unknown[] } }
    const game = parsed.arguments?.game ?? []
    const at = game.indexOf('--fml.neoFormVersion')
    const value = at >= 0 ? game[at + 1] : undefined
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Fallback: libraries/net/minecraft/client/<mc>-<neoform>/ left by a previous install. */
async function neoFormFromLibraries(folder: MinecraftFolder, mcVersion: string): Promise<string | null> {
  const clientDir = join(folder.libraries, 'net', 'minecraft', 'client')
  let names: string[]
  try {
    names = await readdir(clientDir)
  } catch {
    return null
  }
  const prefix = `${mcVersion}-`
  const candidates = names.filter((n) => n.startsWith(prefix)).sort().reverse()
  return candidates.length > 0 ? candidates[0].slice(prefix.length) : null
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
