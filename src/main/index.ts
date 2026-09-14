import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { resolvePaths } from './core/paths'
import { initAutoUpdate } from './electron/update'
import { registerIpc } from './ipc'

log.initialize()
log.transports.file.level = 'info'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 820,
    minHeight: 560,
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

  // Renderer errors land in the same log file as the main process, so a player can send one file.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') log.error(`renderer: ${event.message} (${event.sourceId}:${event.lineNumber})`)
    else if (event.level === 'warning') log.warn(`renderer: ${event.message}`)
  })

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

app.whenReady().then(() => {
  const paths = resolvePaths(app.getPath('userData'))
  log.info(
    `Consortium Launcher ${app.getVersion()} starting (${process.platform}-${process.arch}, packaged=${app.isPackaged}, root=${paths.root})`,
  )
  const win = createWindow()
  registerIpc(win, paths)
  initAutoUpdate(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
