import { app, ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../../shared/types'

let current: UpdateStatus = { state: 'idle' }

function publish(win: BrowserWindow, status: UpdateStatus): void {
  current = status
  if (!win.isDestroyed()) win.webContents.send('update:status', status)
}

/**
 * Wires electron-updater to the renderer. Checks GitHub Releases on every start
 * (packaged builds only), downloads in the background and installs on quit, or
 * immediately when the player clicks "Restart to update".
 *
 * CONSORTIUM_AUTO_INSTALL_UPDATE=1 installs as soon as the download finishes;
 * used by the automated update-channel test, never set for players.
 */
export function initAutoUpdate(win: BrowserWindow): void {
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('checking-for-update', () => publish(win, { state: 'checking' }))
  autoUpdater.on('update-available', (info) => publish(win, { state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => publish(win, { state: 'not-available' }))
  autoUpdater.on('download-progress', (p) => publish(win, { state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    publish(win, { state: 'downloaded', version: info.version })
    if (process.env['CONSORTIUM_AUTO_INSTALL_UPDATE'] === '1') {
      log.info('auto-install test hook: installing update now')
      autoUpdater.quitAndInstall(true, true)
    }
  })
  autoUpdater.on('error', (err) => publish(win, { state: 'error', message: err.message }))

  ipcMain.handle('update:status', () => current)
  ipcMain.handle('update:install', () => {
    log.info('player requested update install')
    autoUpdater.quitAndInstall(false, true)
  })

  if (!app.isPackaged) {
    log.info('dev build: update check skipped')
    return
  }
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    log.warn('update check failed', err)
    publish(win, { state: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
