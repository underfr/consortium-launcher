import { useCallback, useEffect, useState } from 'react'
import { resolveOptions } from '../../shared/options'
import type { AccountSummary, LauncherJson, OptionRules, PackOption, Phase, ProgressEvent, Settings, UpdateStatus } from '../../shared/types'

type GameState = 'idle' | 'preparing' | 'running'

const PHASE_LABEL: Record<Phase, string> = {
  java: 'Java',
  minecraft: 'Minecraft',
  neoforge: 'NeoForge',
  pack: 'Mods',
  launch: 'Launch',
}

const NO_RULES: OptionRules = { lowPresetDisables: [], optionRequires: {} }

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

function UpdateBanner({ status }: { status: UpdateStatus }): React.JSX.Element | null {
  switch (status.state) {
    case 'checking':
      return <div className="banner">Checking for launcher updates...</div>
    case 'available':
      return <div className="banner">Update {status.version} found, downloading...</div>
    case 'downloading':
      return <div className="banner">Downloading update: {status.percent}%</div>
    case 'downloaded':
      return (
        <div className="banner banner-action">
          <span>Update {status.version} is ready.</span>
          <button onClick={() => void window.api.installUpdate()}>Restart to update</button>
        </div>
      )
    case 'error':
      return <div className="banner banner-error">Update check failed: {status.message}</div>
    default:
      return null
  }
}

function Progress({ event }: { event: ProgressEvent | null }): React.JSX.Element | null {
  if (!event) return null
  const determinate = event.current !== undefined && event.total !== undefined && event.total > 0
  const percent = determinate ? Math.min(100, Math.round((event.current! / event.total!) * 100)) : 0
  const detail = determinate
    ? event.unit === 'bytes'
      ? `${formatBytes(event.current!)} / ${formatBytes(event.total!)}`
      : `${event.current} / ${event.total}`
    : ''
  return (
    <div className="progress">
      <div className="progress-text">
        <strong>{PHASE_LABEL[event.phase]}</strong> {event.message} {detail && <span className="muted">{detail}</span>}
      </div>
      <div className={'bar' + (determinate ? '' : ' bar-indeterminate')}>
        <div className="bar-fill" style={{ width: determinate ? `${percent}%` : '30%' }} />
      </div>
    </div>
  )
}

interface OptionalModsProps {
  options: PackOption[]
  settings: Settings
  rules: OptionRules
  busy: boolean
  onToggle: (file: string, enabled: boolean) => void
}

/**
 * One checkbox per optional entry of the pack. The same rule as the Play handler (resolveOptions)
 * decides what is checked and what is held off, so the card never promises a file the sync skips.
 */
function OptionalMods({ options, settings, rules, busy, onToggle }: OptionalModsProps): React.JSX.Element {
  const resolved = new Map(resolveOptions(settings, options, rules, () => undefined).map((r) => [r.file, r]))
  const nameOf = (file: string): string => options.find((o) => o.file === file)?.name ?? file
  return (
    <section className="options">
      <h2>Optional mods</h2>
      {options.length === 0 ? (
        <p className="muted">Optional mods appear after the first launch.</p>
      ) : (
        <ul className="option-list">
          {options.map((option) => {
            const state = resolved.get(option.file)
            const enabled = state?.enabled ?? option.default
            const lock = state?.lock
            const note = lock?.reason === 'low-preset' ? 'Forced off by the low RAM preset' : lock?.reason === 'requires' ? `Needs ${nameOf(lock.file)}` : null
            return (
              <li key={option.file} className={'option' + (lock ? ' option-locked' : '')}>
                <label className="toggle option-toggle">
                  <input type="checkbox" checked={enabled} disabled={busy || lock !== undefined} onChange={(e) => onToggle(option.file, e.target.checked)} />
                  <span className="option-name">{option.name}</span>
                </label>
                {option.description && <p className="muted option-text">{option.description}</p>}
                {note && <p className="muted option-note">{note}</p>}
              </li>
            )
          })}
        </ul>
      )}
      <p className="muted option-footer">Changes apply at the next Play.</p>
    </section>
  )
}

export default function App(): React.JSX.Element {
  const [version, setVersion] = useState('...')
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })
  const [account, setAccount] = useState<AccountSummary | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [settings, setSettings] = useState<Settings>({ preset: 'default' })
  const [options, setOptions] = useState<PackOption[]>([])
  const [info, setInfo] = useState<LauncherJson | null>(null)
  const [gameState, setGameState] = useState<GameState>('idle')
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadOptions = useCallback(() => {
    window.api.getPackOptions().then(setOptions).catch(() => setOptions([]))
  }, [])

  useEffect(() => {
    window.api.getInfo().then((i) => setVersion(i.version)).catch(() => setVersion('?'))
    window.api.getUpdateStatus().then(setUpdate).catch(() => undefined)
    window.api.getSettings().then(setSettings).catch(() => undefined)
    window.api.getLauncherJson().then(setInfo).catch(() => setInfo(null))
    window.api.getGameState().then(setGameState).catch(() => undefined)
    window.api.signInSilent().then(setAccount).catch(() => setAccount(null))
    loadOptions()
    const subs = [
      window.api.onUpdateStatus(setUpdate),
      window.api.onAccount(setAccount),
      window.api.onGameState((s) => {
        setGameState(s)
        if (s === 'idle') setProgress(null)
        // A sync just ran (running) or the game closed (idle): the cached option list may be newer.
        if (s !== 'preparing') loadOptions()
      }),
      window.api.onProgress(setProgress),
      window.api.onGameExit((code) => {
        if (code !== 0 && code !== null) setError(`Minecraft closed with exit code ${code}. Check the game log if it crashed.`)
      }),
    ]
    return () => subs.forEach((u) => u())
  }, [loadOptions])

  const signIn = useCallback(async () => {
    setError(null)
    setSigningIn(true)
    try {
      setAccount(await window.api.signIn())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSigningIn(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    await window.api.signOut()
    setAccount(null)
  }, [])

  const play = useCallback(async () => {
    setError(null)
    try {
      await window.api.play()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const toggleLow = useCallback(
    async (low: boolean) => {
      const next: Settings = { ...settings, preset: low ? 'low' : 'default' }
      setSettings(next)
      await window.api.setSettings(next)
    },
    [settings],
  )

  const toggleOption = useCallback(
    async (file: string, enabled: boolean) => {
      const next: Settings = { ...settings, options: { ...settings.options, [file]: enabled } }
      setSettings(next)
      await window.api.setSettings(next)
    },
    [settings],
  )

  const busy = gameState !== 'idle'
  const rules: OptionRules = info ?? NO_RULES

  return (
    <div className="shell">
      <header>
        <div>
          <h1>The Consortium</h1>
          <span className="version">launcher v{version}</span>
        </div>
        <div className="account">
          {account ? (
            <>
              <span className="chip">{account.name}</span>
              <button className="link" onClick={() => void signOut()} disabled={busy}>
                Sign out
              </button>
            </>
          ) : (
            <button className="secondary" onClick={() => void signIn()} disabled={signingIn}>
              {signingIn ? 'Waiting for the browser...' : 'Sign in with Microsoft'}
            </button>
          )}
        </div>
      </header>

      <UpdateBanner status={update} />

      <main>
        <section className="news">
          <p className="motd">{info?.motd ?? 'Could not load server news. Check your connection.'}</p>
          {info?.news.slice(0, 3).map((n) => (
            <article key={n.date + n.title}>
              <span className="muted">{n.date}</span> <strong>{n.title}</strong>
              <p>{n.text}</p>
            </article>
          ))}
        </section>

        <section className="play-area">
          <label className="toggle">
            <input type="checkbox" checked={settings.preset === 'low'} disabled={busy} onChange={(e) => void toggleLow(e.target.checked)} />
            Low RAM / low graphics (8 GB machines)
          </label>
          <OptionalMods options={options} settings={settings} rules={rules} busy={busy} onToggle={(file, enabled) => void toggleOption(file, enabled)} />
          <button className="play" onClick={() => void play()} disabled={!account || busy}>
            {gameState === 'running' ? 'Running' : gameState === 'preparing' ? 'Preparing...' : 'Play'}
          </button>
          {!account && <p className="muted">Sign in to play.</p>}
          <Progress event={progress} />
          {error && <div className="error">{error}</div>}
        </section>
      </main>

      <footer>NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</footer>
    </div>
  )
}
