// The optional-mod rule, shared by the Play handler (main), the smoke tests and the renderer so
// the checkbox a player sees and the file list syncPack receives can never disagree.
// Keep this file free of Node or Electron imports: it is compiled into both worlds.

import type { OptionRules, PackOption, Settings } from './types'

/** Why an entry is forced off regardless of the stored choice. */
export type OptionLock = { reason: 'low-preset' } | { reason: 'requires'; file: string }

export interface ResolvedOption {
  file: string
  /** What syncPack will install: the stored choice (else the pack default) after the rules. */
  enabled: boolean
  /** Present when a rule holds the entry off; the stored choice itself is untouched. */
  lock?: OptionLock
}

export type OptionLog = (line: string) => void

/**
 * Applies the player's choices and the pack's rules to the option list:
 *   1. every entry starts from Settings.options[file], else PackOption.default;
 *   2. the low RAM preset holds the entries named in lowPresetDisables off;
 *   3. an entry named in optionRequires is held off whenever the entry it requires ends up off
 *      (chains are followed until nothing changes).
 * A locked entry is off and reports why, so the UI can grey the row out with the reason.
 * A rule that names a file absent from the option list is logged once and ignored: the pack
 * renamed or dropped that entry, and the drift must be visible in the launcher log.
 */
export function resolveOptions(settings: Settings, packOptions: PackOption[], rules: OptionRules, log: OptionLog = console.log): ResolvedOption[] {
  const byFile = new Map<string, ResolvedOption>()
  for (const option of packOptions) {
    byFile.set(option.file, { file: option.file, enabled: settings.options?.[option.file] ?? option.default })
  }

  for (const file of rules.lowPresetDisables) {
    const entry = byFile.get(file)
    if (!entry) {
      log(`launcher.json lowPresetDisables names "${file}", which is not an optional entry of the pack`)
      continue
    }
    if (settings.preset === 'low') {
      entry.enabled = false
      entry.lock = { reason: 'low-preset' }
    }
  }

  const requirements: [ResolvedOption, ResolvedOption][] = []
  for (const [file, required] of Object.entries(rules.optionRequires)) {
    const entry = byFile.get(file)
    const requiredEntry = byFile.get(required)
    if (!entry) log(`launcher.json optionRequires names "${file}", which is not an optional entry of the pack`)
    if (!requiredEntry) log(`launcher.json optionRequires says "${file}" needs "${required}", which is not an optional entry of the pack`)
    if (entry && requiredEntry && entry !== requiredEntry) requirements.push([entry, requiredEntry])
  }
  // Fixed point: a chain a -> b -> c settles in at most one pass per link.
  for (let changed = true, guard = 0; changed && guard <= requirements.length; guard++) {
    changed = false
    for (const [entry, requiredEntry] of requirements) {
      if (requiredEntry.enabled || entry.lock) continue
      changed = changed || entry.enabled
      entry.enabled = false
      entry.lock = { reason: 'requires', file: requiredEntry.file }
    }
  }

  return packOptions.map((option) => byFile.get(option.file) as ResolvedOption)
}

/** The record syncPack consumes: every optional entry of the pack with its effective value. */
export function effectiveOptions(settings: Settings, packOptions: PackOption[], rules: OptionRules, log: OptionLog = console.log): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const resolved of resolveOptions(settings, packOptions, rules, log)) out[resolved.file] = resolved.enabled
  return out
}
