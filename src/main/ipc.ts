import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { totalmem } from 'node:os'
import log from 'electron-log/main'
import type { AccountSummary, LauncherJson, PackOption, ProgressEvent, Settings } from '../shared/types'
import { AuthError, loginInteractive, loginSilent, logout, type Session } from './core/auth'
import { INSTANCE_ID, MS_CLIENT_ID, PACK_BASE_URL } from './core/config'
import { ensureJava } from './core/java'
import { launchGame } from './core/launch'
import { ensureNeoForge } from './core/neoforge'
import { readLauncherJson, readPackOptions, readPackVersions, syncPack } from './core/pack'
import type { LauncherPaths } from './core/paths'
import { effectiveOptions, loadSettings, presetFor, saveSettings } from './core/settings'
import { fallbackHeadDataUrl, headForProfile } from './core/skin'
import { ensureVanilla } from './core/vanilla'
import { createTokenStore } from './electron/token-store'

export type GameState = 'idle' | 'preparing' | 'running'

/**
 * Everything the renderer can ask for. One session and one game process at a time;
 * the renderer only ever sees summaries (never tokens).
 */
export function registerIpc(win: BrowserWindow, paths: LauncherPaths): void {
  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const coreLog = (line: string): void => log.info(line)
  const authOptions = {
    clientId: MS_CLIENT_ID,
    store: createTokenStore(paths, coreLog),
    openExternal: (url: string) => shell.openExternal(url),
    log: coreLog,
  }

  let session: Session | null = null
  let state: GameState = 'idle'
  /** Head of the signed-in profile as a data URL; the bundled face stands in until skin.ts has answered. */
  let head: { profileId: string; dataUrl: string } | null = null

  const summary = (s: Session | null): AccountSummary | null =>
    s
      ? {
          id: s.profile.id,
          name: s.profile.name,
          headDataUrl: head?.profileId === s.profile.id ? head.dataUrl : fallbackHeadDataUrl(),
        }
      : null
  const setState = (next: GameState): void => {
    state = next
    send('game:state', state)
  }
  const describe = (err: unknown): string => {
    if (err instanceof AuthError) return err.message
    if (err instanceof Error) return err.message
    return String(err)
  }

  /**
   * Resolves the head from the disk first (cached skin: a few milliseconds; default skin read from
   * the client jar: about 150 ms; else the bundled face) so the sign-in result already carries it,
   * then downloads a missing or outdated skin detached from the caller and pushes the account
   * again once the head changed. A slow CDN therefore never delays the sign-in.
   */
  const loadHead = async (s: Session): Promise<void> => {
    const id = s.profile.id
    let local: Awaited<ReturnType<typeof headForProfile>>
    try {
      local = await headForProfile(paths, id, s.skin, { network: false, log: coreLog })
    } catch (err) {
      // headForProfile never throws by contract; a bug there must still not fail a successful sign-in.
      log.warn('skin: could not resolve the head, keeping the fallback face: ' + describe(err))
      return
    }
    if (session?.profile.id !== id) return
    // A token refresh keeps the head already shown for this profile rather than dropping to the default.
    if (local.source === 'skin' || head?.profileId !== id) head = { profileId: id, dataUrl: local.dataUrl }
    if (local.source === 'skin' || !s.skin) return
    const skin = s.skin
    void headForProfile(paths, id, skin, { network: true, signal: AbortSignal.timeout(15_000), log: coreLog })
      .then((remote) => {
        if (session?.profile.id !== id || remote.dataUrl === head?.dataUrl) return
        head = { profileId: id, dataUrl: remote.dataUrl }
        send('auth:account', summary(session))
      })
      .catch((err: unknown) => log.warn('skin: head update failed: ' + describe(err)))
  }

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    totalMemoryBytes: totalmem(),
    packBaseUrl: PACK_BASE_URL,
  }))

  ipcMain.handle('auth:silent', async (): Promise<AccountSummary | null> => {
    try {
      session = await loginSilent(authOptions)
    } catch (err) {
      log.warn('silent sign-in failed: ' + describe(err))
      session = null
    }
    if (session) await loadHead(session)
    return summary(session)
  })

  ipcMain.handle('auth:login', async (): Promise<AccountSummary> => {
    session = await loginInteractive(authOptions)
    await loadHead(session)
    return summary(session) as AccountSummary
  })

  ipcMain.handle('auth:logout', async (): Promise<void> => {
    session = null
    head = null
    await logout(authOptions)
  })

  ipcMain.handle('settings:get', (): Promise<Settings> => loadSettings(paths, { log: coreLog }))
  ipcMain.handle('settings:set', (_e, s: Settings): Promise<void> => saveSettings(paths, s))

  ipcMain.handle('pack:launcherJson', (): Promise<LauncherJson> => readLauncherJson(PACK_BASE_URL))

  // The optional entries of the pack for the settings card. A failure (offline before the first
  // sync) hides the card instead of breaking the window; the next Play refreshes the cached list.
  ipcMain.handle('pack:options', async (): Promise<PackOption[]> => {
    try {
      return await readPackOptions(paths, INSTANCE_ID, PACK_BASE_URL, 'client', { log: coreLog })
    } catch (err) {
      log.warn('could not read the optional entries of the pack: ' + describe(err))
      return []
    }
  })

  ipcMain.handle('game:state', () => state)

  ipcMain.handle('game:play', async (): Promise<void> => {
    if (state !== 'idle') throw new Error('The game is already starting or running.')
    if (!session) throw new Error('Sign in with your Microsoft account first.')
    setState('preparing')
    const report = (e: ProgressEvent): void => send('game:progress', e)
    try {
      // Refresh the Minecraft token when it is close to expiry (it lives 24 h).
      if (session.expiresAt - Date.now() < 10 * 60_000) {
        const refreshed = await loginSilent(authOptions)
        if (!refreshed) throw new AuthError('Your session expired. Sign in again.', 'unknown')
        session = refreshed
        await loadHead(session)
        send('auth:account', summary(session))
      }

      // Settings and launcher.json come first: the sync needs the optional-mod choices and the
      // pack's rules (low preset, requirements) to decide which optional entries to install.
      const settings = await loadSettings(paths, { log: coreLog })
      const launcherJson = await readLauncherJson(PACK_BASE_URL)

      const java = await ensureJava(paths, report, { log: coreLog })
      const versions = await readPackVersions(PACK_BASE_URL)
      await ensureVanilla(paths, versions.minecraft, report, { log: coreLog })
      const versionId = await ensureNeoForge(paths, versions.minecraft, versions.neoforge, java.javaPath, report, { log: coreLog })
      await syncPack({
        paths,
        instanceId: INSTANCE_ID,
        baseUrl: PACK_BASE_URL,
        side: 'client',
        report,
        resolveOptions: (options) => effectiveOptions(settings, options, launcherJson, coreLog),
        log: coreLog,
      })

      const server = parseServer(launcherJson.server.address)
      report({ phase: 'launch', message: 'Starting Minecraft' })
      const proc = await launchGame({
        paths,
        instanceId: INSTANCE_ID,
        versionId,
        javaPath: java.javaPath,
        preset: presetFor(settings, totalmem()),
        profile: session.profile,
        accessToken: session.accessToken,
        xuid: session.xuid,
        clientId: MS_CLIENT_ID,
        server,
        log: coreLog,
      })
      setState('running')
      proc.once('exit', (code) => {
        log.info('game exited with code ' + String(code))
        setState('idle')
        send('game:exit', code)
      })
    } catch (err) {
      setState('idle')
      log.error('play failed: ' + describe(err))
      throw new Error(describe(err))
    }
  })
}

function parseServer(address: string): { host: string; port?: number } | undefined {
  const trimmed = address.trim()
  if (!trimmed) return undefined
  const [host, port] = trimmed.split(':')
  if (!host) return undefined
  const parsed = port ? Number.parseInt(port, 10) : undefined
  return { host, port: parsed && Number.isFinite(parsed) ? parsed : undefined }
}
