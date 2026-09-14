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

export interface SyncResult {
  pack: PackInfo
  downloaded: number
  deleted: number
  skipped: number
  /** True when pack.toml and index.toml hashes matched the last sync and nothing was touched. */
  unchanged: boolean
}

export interface LauncherJson {
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
}

export interface Settings {
  preset: PresetId
  /** Optional overrides of the preset's -Xmx, in MB. */
  maxMemoryMb?: number
}
