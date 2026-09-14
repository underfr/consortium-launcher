import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can reach. Keep it small and typed (see index.d.ts).
const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
}

contextBridge.exposeInMainWorld('api', api)

export type LauncherApi = typeof api
