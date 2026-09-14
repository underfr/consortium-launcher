import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AccountSummary, LauncherJson, ProgressEvent, Settings, UpdateStatus } from '../shared/types'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// The only surface the renderer can reach. Keep it small and typed (see index.d.ts).
const api = {
  getInfo: (): Promise<{ version: string; totalMemoryBytes: number; packBaseUrl: string }> => ipcRenderer.invoke('app:info'),

  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): Unsubscribe => subscribe('update:status', cb),

  signInSilent: (): Promise<AccountSummary | null> => ipcRenderer.invoke('auth:silent'),
  signIn: (): Promise<AccountSummary> => ipcRenderer.invoke('auth:login'),
  signOut: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  onAccount: (cb: (account: AccountSummary | null) => void): Unsubscribe => subscribe('auth:account', cb),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:set', s),

  getLauncherJson: (): Promise<LauncherJson> => ipcRenderer.invoke('pack:launcherJson'),

  play: (): Promise<void> => ipcRenderer.invoke('game:play'),
  getGameState: (): Promise<'idle' | 'preparing' | 'running'> => ipcRenderer.invoke('game:state'),
  onGameState: (cb: (state: 'idle' | 'preparing' | 'running') => void): Unsubscribe => subscribe('game:state', cb),
  onProgress: (cb: (e: ProgressEvent) => void): Unsubscribe => subscribe('game:progress', cb),
  onGameExit: (cb: (code: number | null) => void): Unsubscribe => subscribe('game:exit', cb),
}

contextBridge.exposeInMainWorld('api', api)

export type LauncherApi = typeof api
