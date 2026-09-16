// Player settings (preset choice, optional memory override, optional-mod choices) as JSON under
// <root>/state. Kept forgiving on purpose: a missing or damaged file falls back to the defaults
// instead of blocking the Play button, and every value is sanitized both when read and when written.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LaunchPreset, PresetId, Settings } from '../../shared/types'
import { defaultPreset, lowPreset } from './launch'
import type { LauncherPaths } from './paths'

// The optional-mod rule lives in src/shared/options.ts (pure, also used by the renderer); the Play
// handler and the smoke tests reach it through this module like the rest of the settings API.
export { effectiveOptions, resolveOptions } from '../../shared/options'
export type { OptionLock, ResolvedOption } from '../../shared/options'

export const SETTINGS_FILE = 'settings.json'
/** Bounds of the player's -Xmx override, in MB. */
export const MIN_MEMORY_MB = 2048
export const MAX_MEMORY_MB = 12288

const PRESET_IDS: readonly PresetId[] = ['default', 'low']

/** Optional-mod choices are keyed by metafile path; anything else in the record is noise. */
const OPTION_KEY_SUFFIX = '.pw.toml'

export function defaultSettings(): Settings {
  return { preset: 'default' }
}

export function settingsPath(paths: LauncherPaths): string {
  return join(paths.state, SETTINGS_FILE)
}

/** Reads <state>/settings.json; a missing file is the first run, a damaged one is logged and ignored. */
export async function loadSettings(paths: LauncherPaths, opts: { log?: (line: string) => void } = {}): Promise<Settings> {
  const log = opts.log ?? console.log
  const file = settingsPath(paths)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`settings: cannot read ${file} (${err instanceof Error ? err.message : String(err)}), using defaults`)
    }
    return defaultSettings()
  }
  try {
    return normalizeSettings(JSON.parse(text))
  } catch (err) {
    log(`settings: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}), using defaults`)
    return defaultSettings()
  }
}

/** Writes the sanitized settings atomically (temp file + rename). */
export async function saveSettings(paths: LauncherPaths, s: Settings): Promise<void> {
  const file = settingsPath(paths)
  await mkdir(paths.state, { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(normalizeSettings(s), null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** The preset the player chose, with their memory override applied (clamped to 2048..12288 MB). */
export function presetFor(settings: Settings, totalMemoryBytes: number): LaunchPreset {
  const preset = settings.preset === 'low' ? lowPreset() : defaultPreset(totalMemoryBytes)
  if (settings.maxMemoryMb !== undefined) preset.maxMemoryMb = clampMemory(settings.maxMemoryMb)
  return preset
}

/**
 * Keeps only the fields the launcher knows, with valid values; anything else becomes the default.
 * Optional-mod choices survive only as "<path>.pw.toml": boolean pairs; the record is omitted when empty.
 */
export function normalizeSettings(raw: unknown): Settings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const preset = PRESET_IDS.find((id) => id === source['preset']) ?? 'default'
  const memory = source['maxMemoryMb']
  const settings: Settings = { preset }
  if (typeof memory === 'number' && Number.isFinite(memory) && memory > 0) settings.maxMemoryMb = clampMemory(memory)
  const options = source['options']
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    const kept: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
      if (key.endsWith(OPTION_KEY_SUFFIX) && key.length > OPTION_KEY_SUFFIX.length && typeof value === 'boolean') kept[key] = value
    }
    if (Object.keys(kept).length > 0) settings.options = kept
  }
  return settings
}

function clampMemory(mb: number): number {
  return Math.min(Math.max(Math.round(mb), MIN_MEMORY_MB), MAX_MEMORY_MB)
}
