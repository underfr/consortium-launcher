import { join } from 'node:path'

/**
 * On-disk layout under one root (Electron: app.getPath('userData'); smoke tests: any temp dir).
 *
 *   <root>/runtime/java21/            Mojang java-runtime-delta (bin/java.exe or bin/java)
 *   <root>/minecraft/                 shared vanilla + NeoForge files: versions/ libraries/ assets/
 *   <root>/instances/<id>/            game directory: mods/ config/ kubejs/ saves/ options.txt logs/
 *   <root>/state/                     settings.json, sync-<id>.json, auth.bin, skins/<profileId>.png
 *   <root>/logs/                      launcher and game logs
 */
export interface LauncherPaths {
  root: string
  runtime: string
  java: string
  minecraft: string
  instances: string
  state: string
  logs: string
  instance: (id: string) => string
}

export function resolvePaths(root: string): LauncherPaths {
  const instances = join(root, 'instances')
  return {
    root,
    runtime: join(root, 'runtime'),
    java: join(root, 'runtime', 'java21'),
    minecraft: join(root, 'minecraft'),
    instances,
    state: join(root, 'state'),
    logs: join(root, 'logs'),
    instance: (id: string) => join(instances, id),
  }
}

/** Path of the Java executable inside a Mojang runtime directory for this platform. */
export function javaExecutable(javaDir: string): string {
  if (process.platform === 'win32') return join(javaDir, 'bin', 'java.exe')
  if (process.platform === 'darwin') return join(javaDir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')
  return join(javaDir, 'bin', 'java')
}

/** Mojang runtime platform key for the current OS/arch, or null when unsupported. */
export function mojangPlatformKey(): 'windows-x64' | 'windows-arm64' | 'mac-os' | 'mac-os-arm64' | 'linux' | null {
  const { platform, arch } = process
  if (platform === 'win32') return arch === 'arm64' ? 'windows-arm64' : arch === 'x64' ? 'windows-x64' : null
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  if (platform === 'linux') return arch === 'x64' ? 'linux' : null
  return null
}
