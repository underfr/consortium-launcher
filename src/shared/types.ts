// Types shared between the main process, the preload bridge and the renderer.
// Keep this file free of Node or Electron imports: it is compiled into both worlds.

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }

/** The five phases the Play button walks through, in order. */
export type Phase = 'java' | 'minecraft' | 'neoforge' | 'pack' | 'launch'

export interface ProgressEvent {
  phase: Phase
  /** Short, player-facing sentence in English, e.g. "Downloading libraries". */
  message: string
  /** Optional determinate progress. Both present or both absent. */
  current?: number
  total?: number
  unit?: 'bytes' | 'files'
}

export type ProgressReporter = (event: ProgressEvent) => void

/** Memory and graphics preset chosen by the player. */
export type PresetId = 'default' | 'low'

export interface LaunchPreset {
  id: PresetId
  /** -Xmx in megabytes. */
  maxMemoryMb: number
  /** JVM flags appended after the memory flags (Mojang G1 flags by default). */
  extraJvmArgs: string[]
  /** Keys written into options.txt before launch (e.g. renderDistance). Empty for 'default'. */
  optionsOverrides: Record<string, string>
}

export interface PackInfo {
  name: string
  version: string
  minecraft: string
  neoforge: string
  /** Number of [[files]] entries in index.toml that apply to this side. */
  files: number
}

export type PackSide = 'both' | 'client' | 'server'

/**
 * One optional entry of the pack (a metafile whose [option] block says optional = true), as the
 * player sees it. `file` is the metafile path and the key of Settings.options and of the
 * enabledOptions record given to syncPack, e.g. "mods/iris.pw.toml" or "shaderpacks/foo.pw.toml".
 */
export interface PackOption {
  file: string
  name: string
  description?: string
  /** What the pack installs when the player never made a choice. */
  default: boolean
  side: PackSide
}

export interface SyncResult {
  pack: PackInfo
  downloaded: number
  deleted: number
  skipped: number
  /** True when pack.toml and index.toml hashes matched the last sync and nothing was touched. */
  unchanged: boolean
  /** Optional entries of the pack for this side, in index order (from the cache when unchanged). */
  options: PackOption[]
}

/**
 * Rules the pack publishes in launcher.json about its optional entries. Both fields are optional
 * in the file (an older pack has neither) and always present here, empty when absent.
 */
export interface OptionRules {
  /** Metafile paths forced off while the low RAM preset is active, e.g. ["mods/iris.pw.toml"]. */
  lowPresetDisables: string[]
  /** Metafile path -> metafile path it needs; the entry is forced off whenever its requirement is off. */
  optionRequires: Record<string, string>
}

export interface LauncherJson extends OptionRules {
  schemaVersion: 1
  minLauncherVersion: string
  server: { name: string; address: string }
  motd: string
  news: { date: string; title: string; text: string }[]
}

export interface AccountSummary {
  /** Minecraft profile UUID without dashes. */
  id: string
  name: string
  /**
   * The player's 8x8 head (face with the hat layer on top) as a data:image/png;base64 URL, to be
   * shown pixelated at 32 px. Always present: the game's default skin for this UUID or the bundled
   * fallback face stands in until the skin is downloaded, and a second auth:account push carries
   * the real one once it is.
   */
  headDataUrl: string
}

export interface Settings {
  preset: PresetId
  /** Optional overrides of the preset's -Xmx, in MB. */
  maxMemoryMb?: number
  /** Player choices for optional entries, keyed by metafile path. A missing key means the pack default. */
  options?: Record<string, boolean>
}
