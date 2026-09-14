// Vanilla Minecraft (version json, client jar, libraries, assets) under <root>/minecraft.

import { access, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MinecraftFolder, Version, type ResolvedVersion } from '@xmcl/core'
import { getVersionList, installTask } from '@xmcl/installer'
import type { ProgressReporter } from '../../shared/types'
import { createTaskProgress, describeError, fetchWithAgent, libraryHeaders, withRetries } from './java'
import type { LauncherPaths } from './paths'

/** v2 carries the sha1 of every version json; the package URL itself is never hardcoded. */
const VERSION_MANIFEST_V2 = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

/**
 * Written into versions/<mc>/ when a run of ensureVanilla completes, removed when the next
 * one starts. Only while it exists are the assets pre-validated by size instead of sha1.
 * The client jar cannot serve as that signal: it is written before the assets start, and an
 * asset above 2 MB is fetched as parallel byte ranges written in place, so a download killed
 * halfway can leave a file at its final size with zero-filled holes that a size check would
 * accept forever.
 */
export const ASSETS_VERIFIED_MARKER = '.assets-verified'

export class VanillaError extends Error {
  override name = 'VanillaError'
}

/**
 * Resolves mcVersion through Mojang's version manifest on every call (one small request),
 * then lets @xmcl/installer download whatever is missing. Files already on disk are
 * re-validated: libraries and the client jar by sha1 on every run; assets by size when the
 * previous run completed (a few hundred ms) and by sha1 otherwise (hashing the ~400 MB of
 * assets costs a couple of seconds, so it only happens after a fresh or interrupted run).
 */
export async function ensureVanilla(
  paths: LauncherPaths,
  mcVersion: string,
  report: ProgressReporter,
  opts: { log?: (line: string) => void } = {},
): Promise<ResolvedVersion> {
  const log = opts.log ?? console.log
  const folder = MinecraftFolder.from(paths.minecraft)
  report({ phase: 'minecraft', message: `Checking Minecraft ${mcVersion}` })

  const list = await getVersionList({ remote: VERSION_MANIFEST_V2, fetch: fetchWithAgent })
  const meta = list.versions.find((v) => v.id === mcVersion)
  if (!meta) {
    throw new VanillaError(
      `Minecraft ${mcVersion} is not in Mojang's version list (${VERSION_MANIFEST_V2}). Check the pack settings or try again later.`,
    )
  }

  // The marker is dropped before any byte moves, so a run that does not reach the end (closed
  // launcher, crash, power loss) always leads to a full sha1 pass next time.
  const marker = join(folder.getVersionRoot(mcVersion), ASSETS_VERIFIED_MARKER)
  const verifiedBefore = await exists(marker)
  if (verifiedBefore) await removeMarker(marker)

  const progress = createTaskProgress('minecraft', report, [
    { path: 'install.version', message: `Downloading Minecraft ${mcVersion}`, unit: 'bytes' },
    { path: 'install.dependencies', message: 'Downloading game files', unit: 'bytes' },
  ])
  const started = Date.now()
  try {
    await withRetries('minecraft', log, () =>
      installTask(meta, folder, {
        headers: libraryHeaders(),
        // A retry after a failed attempt that already moved bytes may find ranged files with
        // holes at their final size, so from then on only sha1 is trusted.
        prevalidSizeOnly: verifiedBefore && progress.stats.transferredBytes === 0,
      }).startAndWait(progress.context),
    )
  } catch (err) {
    throw new VanillaError(
      `Downloading Minecraft ${mcVersion} failed: ${describeError(err)}. Check your internet connection and try again.`,
    )
  }
  await writeFile(marker, new Date().toISOString() + '\n', 'utf8')
  const elapsed = Date.now() - started
  const transferred = progress.stats.transferredBytes
  if (transferred === 0) log(`minecraft: ${mcVersion} cached (verified in ${elapsed} ms${verifiedBefore ? '' : ', full hash check'})`)
  else log(`minecraft: ${mcVersion} downloaded ${(transferred / 1_048_576).toFixed(1)} MB in ${elapsed} ms`)

  try {
    return await Version.parse(folder, mcVersion)
  } catch (err) {
    // Version.parse rejects with plain objects ({ error: 'MissingVersionJson', ... }), not Errors.
    const why = err instanceof Error ? err.message : JSON.stringify(err)
    throw new VanillaError(`Minecraft ${mcVersion} is installed but its version file cannot be read: ${why}`)
  }
}

/** Deleting the marker is what keeps the size-only check honest, so a failure here is fatal. */
async function removeMarker(marker: string): Promise<void> {
  try {
    await unlink(marker)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new VanillaError(`Could not remove ${marker}: ${describeError(err)}. Check that the folder is writable and try again.`)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
