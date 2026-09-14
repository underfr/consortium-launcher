import { safeStorage } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StoredTokens, TokenStore } from '../core/auth'
import type { LauncherPaths } from '../core/paths'

/**
 * Persists the Microsoft refresh token encrypted with the OS keychain (DPAPI on Windows,
 * Keychain on macOS, secret-service on Linux). When Electron can only offer the "basic_text"
 * backend (Linux without a keyring) nothing is written: the player signs in again next time
 * instead of the token sitting unencrypted on disk.
 */
export function createTokenStore(paths: LauncherPaths, log: (line: string) => void): TokenStore {
  const file = join(paths.state, 'auth.bin')

  const usable = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
    return true
  }

  return {
    async load() {
      try {
        const buf = await readFile(file)
        if (!usable()) return null
        const parsed: unknown = JSON.parse(safeStorage.decryptString(buf))
        if (!parsed || typeof parsed !== 'object') return null
        const t = parsed as Partial<StoredTokens>
        if (typeof t.refreshToken !== 'string' || typeof t.msClientId !== 'string') return null
        return { refreshToken: t.refreshToken, msClientId: t.msClientId }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log('token store: unreadable, ignoring (' + String(err) + ')')
        return null
      }
    },
    async save(t) {
      if (!usable()) {
        log('token store: no OS-protected storage available, session will not be remembered')
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, safeStorage.encryptString(JSON.stringify(t)))
    },
    async clear() {
      await rm(file, { force: true })
    },
  }
}
