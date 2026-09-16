// Unit checks for the pure settings helpers: normalizeSettings (what survives a save) and the
// optional-mod rule (effectiveOptions / resolveOptions) with the low preset, the requirement
// cascade and the missing-key warning. No network, no disk.
//
//   npx tsx scripts/smoke-settings.ts

import { effectiveOptions, normalizeSettings, resolveOptions } from '../src/main/core/settings'
import type { OptionRules, PackOption, Settings } from '../src/shared/types'

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`)
}

function same(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${message}: expected ${e}, got ${a}`)
}

const IRIS = 'mods/iris.pw.toml'
const REIMAGINED = 'shaderpacks/complementary-reimagined.pw.toml'
const MAKEUP = 'shaderpacks/makeup-ultra-fast-shaders.pw.toml'
const SKINS = 'mods/3dskinlayers.pw.toml'

const PACK: PackOption[] = [
  { file: SKINS, name: '3D Skin Layers', description: 'Cosmetic.', default: true, side: 'client' },
  { file: IRIS, name: 'Iris Shaders', description: 'Shader support.', default: false, side: 'client' },
  { file: REIMAGINED, name: 'Complementary Shaders - Reimagined', default: false, side: 'client' },
  { file: MAKEUP, name: 'MakeUp - Ultra Fast', default: false, side: 'client' },
]

const RULES: OptionRules = {
  lowPresetDisables: [IRIS],
  optionRequires: { [REIMAGINED]: IRIS, [MAKEUP]: IRIS },
}

function main(): void {
  console.log('== normalizeSettings')
  same(normalizeSettings(undefined), { preset: 'default' }, 'no input gives the defaults')
  same(normalizeSettings({ preset: 'low', maxMemoryMb: 100 }), { preset: 'low', maxMemoryMb: 2048 }, 'memory is clamped')
  same(
    normalizeSettings({ preset: 'low', options: { [IRIS]: true, [SKINS]: false, 'mods/not-a-metafile.jar': true, [REIMAGINED]: 'yes', '.pw.toml': true } }),
    { preset: 'low', options: { [IRIS]: true, [SKINS]: false } },
    'only "<path>.pw.toml": boolean pairs survive',
  )
  same(normalizeSettings({ preset: 'default', options: { junk: 1 } }), { preset: 'default' }, 'an empty record is dropped')
  same(normalizeSettings({ preset: 'default', options: ['mods/iris.pw.toml'] }), { preset: 'default' }, 'a list is not a record')

  console.log('== effectiveOptions: defaults')
  const warnings: string[] = []
  const log = (line: string): void => {
    warnings.push(line)
  }
  same(
    effectiveOptions({ preset: 'default' }, PACK, RULES, log),
    { [SKINS]: true, [IRIS]: false, [REIMAGINED]: false, [MAKEUP]: false },
    'no choice gives every pack default, shaders held off because Iris is off',
  )
  const noChoice = resolveOptions({ preset: 'default' }, PACK, RULES, log)
  same(noChoice.map((r) => r.file), PACK.map((o) => o.file), 'resolveOptions keeps the pack order')
  same(noChoice.find((r) => r.file === REIMAGINED)?.lock, { reason: 'requires', file: IRIS }, 'a shader pack is locked behind Iris')
  same(noChoice.find((r) => r.file === IRIS)?.lock, undefined, 'Iris is free under the default preset')
  same(noChoice.find((r) => r.file === SKINS)?.lock, undefined, 'an entry with no rule is never locked')

  console.log('== effectiveOptions: choices')
  const shaders: Settings = { preset: 'default', options: { [IRIS]: true, [REIMAGINED]: true, [SKINS]: false } }
  same(
    effectiveOptions(shaders, PACK, RULES, log),
    { [SKINS]: false, [IRIS]: true, [REIMAGINED]: true, [MAKEUP]: false },
    'choices win over defaults and a satisfied requirement is honoured',
  )
  same(resolveOptions(shaders, PACK, RULES, log).find((r) => r.file === MAKEUP)?.lock, undefined, 'an unchosen entry with a satisfied requirement is not locked')

  console.log('== effectiveOptions: low preset')
  const low: Settings = { preset: 'low', options: { [IRIS]: true, [REIMAGINED]: true, [MAKEUP]: true } }
  same(
    effectiveOptions(low, PACK, RULES, log),
    { [SKINS]: true, [IRIS]: false, [REIMAGINED]: false, [MAKEUP]: false },
    'the low preset forces Iris off and the shaders cascade off',
  )
  const lowResolved = resolveOptions(low, PACK, RULES, log)
  same(lowResolved.find((r) => r.file === IRIS)?.lock, { reason: 'low-preset' }, 'Iris reports the preset lock')
  same(lowResolved.find((r) => r.file === REIMAGINED)?.lock, { reason: 'requires', file: IRIS }, 'the shader reports the requirement lock')
  same(low.options, { [IRIS]: true, [REIMAGINED]: true, [MAKEUP]: true }, 'the stored choices are untouched by the rules')
  same(
    effectiveOptions({ ...low, preset: 'default' }, PACK, RULES, log),
    { [SKINS]: true, [IRIS]: true, [REIMAGINED]: true, [MAKEUP]: true },
    'switching the preset back restores the stored choices',
  )
  check(warnings.length === 0, `no warning expected so far, got: ${warnings.join(' | ')}`)

  console.log('== effectiveOptions: chains and cycles')
  const chain: OptionRules = { lowPresetDisables: [], optionRequires: { [MAKEUP]: REIMAGINED, [REIMAGINED]: IRIS } }
  same(
    effectiveOptions({ preset: 'default', options: { [MAKEUP]: true, [REIMAGINED]: true } }, PACK, chain, log),
    { [SKINS]: true, [IRIS]: false, [REIMAGINED]: false, [MAKEUP]: false },
    'a requirement chain settles all the way down',
  )
  const cycle: OptionRules = { lowPresetDisables: [], optionRequires: { [IRIS]: REIMAGINED, [REIMAGINED]: IRIS } }
  same(
    effectiveOptions({ preset: 'default', options: { [IRIS]: true, [REIMAGINED]: true } }, PACK, cycle, log),
    { [SKINS]: true, [IRIS]: true, [REIMAGINED]: true, [MAKEUP]: false },
    'a satisfied cycle terminates and keeps both entries on',
  )
  same(
    effectiveOptions({ preset: 'default', options: { [IRIS]: true, [REIMAGINED]: false } }, PACK, cycle, log),
    { [SKINS]: true, [IRIS]: false, [REIMAGINED]: false, [MAKEUP]: false },
    'a half-satisfied cycle terminates with both entries off',
  )
  const self: OptionRules = { lowPresetDisables: [], optionRequires: { [IRIS]: IRIS } }
  same(effectiveOptions({ preset: 'default', options: { [IRIS]: true } }, PACK, self, log), { [SKINS]: true, [IRIS]: true, [REIMAGINED]: false, [MAKEUP]: false }, 'a self requirement is ignored')
  check(warnings.length === 0, `no warning expected for chains, got: ${warnings.join(' | ')}`)

  console.log('== effectiveOptions: rules naming entries the pack does not have')
  const drift: OptionRules = {
    lowPresetDisables: ['mods/renamed-iris.pw.toml', IRIS],
    optionRequires: { 'shaderpacks/gone.pw.toml': IRIS, [REIMAGINED]: 'mods/renamed-iris.pw.toml' },
  }
  same(
    effectiveOptions({ preset: 'low', options: { [REIMAGINED]: true } }, PACK, drift, log),
    { [SKINS]: true, [IRIS]: false, [REIMAGINED]: true, [MAKEUP]: false },
    'unknown keys are ignored, known ones still apply, an unresolvable requirement leaves the entry alone',
  )
  check(warnings.length === 3, `exactly one warning per unknown key, got ${warnings.length}: ${warnings.join(' | ')}`)
  check(warnings.every((w) => w.startsWith('launcher.json ')), 'warnings name launcher.json')
  check(warnings.some((w) => w.includes('lowPresetDisables') && w.includes('mods/renamed-iris.pw.toml')), 'the lowPresetDisables drift is named')
  check(warnings.some((w) => w.includes('optionRequires names "shaderpacks/gone.pw.toml"')), 'the optionRequires key drift is named')
  check(warnings.some((w) => w.includes(`"${REIMAGINED}" needs "mods/renamed-iris.pw.toml"`)), 'the optionRequires target drift is named')
  for (const w of warnings) console.log(`  warning: ${w}`)

  same(effectiveOptions({ preset: 'low' }, [], RULES, () => undefined), {}, 'an empty option list gives an empty record')

  console.log('\nOK: settings helpers')
}

try {
  main()
} catch (err: unknown) {
  console.error('\nFAILED:', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
}
