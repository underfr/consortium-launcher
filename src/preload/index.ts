import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { UpdateStatus } from '../shared/types'

// The only surface the renderer can reach. Keep it small and typed (see index.d.ts).
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('update:status', listener)
    return () => {
      ipcRenderer.removeListener('update:status', listener)
    }
  },
}

contextBridge.exposeInMainWorld('api', api)

export type LauncherApi = typeof api
