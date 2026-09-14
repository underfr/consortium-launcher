import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

log.initialize()
log.transports.file.level = 'info'
autoUpdater.logger = log

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 800,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Consortium Launcher',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // Every external link opens in the system browser, never inside the launcher.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  log.info(`Consortium Launcher ${app.getVersion()} starting (${process.platform}-${process.arch})`)
  createWindow()

  // Self-update check on every start. Only meaningful in a packaged build with a
  // published GitHub Release; in dev it would just log an error.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => log.warn('update check failed', err))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
