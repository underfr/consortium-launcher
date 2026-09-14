import type { LauncherApi } from './index'

declare global {
  interface Window {
    api: LauncherApi
  }
}

export {}
