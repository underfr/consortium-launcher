# Core module contract (milestone 1)

Rules that every module under `src/main/core/` follows.

- **Pure Node.** No `import` from `electron` anywhere in `src/main/core/**`. Anything Electron-specific
  (userData path, safeStorage, IPC) lives in `src/main/index.ts`, `src/main/ipc.ts` or
  `src/main/electron/*.ts` and is passed in as parameters (paths, callbacks, token store).
- **Shared types** come from `src/shared/types.ts`; paths from `src/main/core/paths.ts`;
  constants from `src/main/core/config.ts`. Do not edit those three files from a module; if you
  need a change, describe it in your report.
- **Idempotent and cheap on re-run.** Every `ensureX` function is called on every Play click.
  When everything is already installed and valid it must finish in well under a second (hash
  or presence checks only, no network round trip unless the design says so).
- **Progress.** Every long operation takes a `ProgressReporter` and calls it with
  player-facing English messages (no em dashes anywhere).
- **Errors.** Throw `Error` subclasses with a clear English `message` a player can read
  (what failed, which file/URL, what to try). Never swallow errors.
- **Network.** HTTPS only. `download.ts` enforces the host allow-list from `config.ts`
  (`ALLOWED_DOWNLOAD_HOSTS`). Send `User-Agent: consortium-launcher/<version>` on every request.
- **Logging.** Core modules must stay Electron-free, so they never import `electron-log`. Accept an
  optional `log: (line: string) => void` in options and default to `console.log`.
- **Style.** TypeScript strict, no `any`, hyphens instead of em dashes, English only.
- **Tests.** Each module ships a smoke script in `scripts/` runnable with `npx tsx scripts/<name>.ts`
  against a temporary root (`resolvePaths(<tmp>)`). Smoke scripts hit the real network (Mojang,
  NeoForge Maven, Modrinth, GitHub) and must print a final `OK: ...` line on success and exit 1
  on failure.

## Pinned libraries (exact, never `latest`)

`@xmcl/core@2.15.1`, `@xmcl/installer@6.1.2`, `@xmcl/user@4.4.2`, `smol-toml@1.8.0`. Verified
API for 6.1.2 (Task based): `getVersionList()`, `installTask(meta, folder)`,
`installNeoForgedTask('neoforge', version, folder, { java, inheritsFrom })`,
`installJavaRuntimeTask({ destination, manifest: { target, version, files } })`,
`DEFAULT_RUNTIME_ALL_URL`. `fetchJavaRuntimeManifest()` in 6.1.2 is broken (undici
`throwOnError`): fetch `all.json` and the target manifest with global `fetch` yourself.
`@xmcl/core`: `MinecraftFolder.from(dir)`, `Version.parse(folder, id)`, `generateArguments(opts)`,
`launch(opts)`.

## Module APIs

### `download.ts`
```ts
export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512' | 'md5'
export interface EnsureFileOptions {
  url: string
  dest: string
  hash?: { algorithm: HashAlgorithm; value: string }
  size?: number
  signal?: AbortSignal
  onProgress?: (downloadedBytes: number, totalBytes: number | undefined) => void
  log?: (line: string) => void
}
/** Returns 'cached' when dest exists and matches hash (or size when no hash), else downloads to
 *  dest + '.part', verifies, renames atomically and returns 'downloaded'. 3 retries with backoff
 *  on network errors and hash mismatches. Throws DownloadError (with url, dest, cause). */
export function ensureFile(o: EnsureFileOptions): Promise<'cached' | 'downloaded'>
export function fetchText(url: string, init?: RequestInit): Promise<string>
export function fetchJson<T>(url: string, init?: RequestInit): Promise<T>
export function hashFile(path: string, algorithm: HashAlgorithm): Promise<string>
export function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]>
export class DownloadError extends Error { url: string; dest?: string }
export function assertAllowedUrl(url: string): void   // https + host in ALLOWED_DOWNLOAD_HOSTS
```

### `java.ts`
```ts
export interface JavaInstall { javaPath: string; version: string /* e.g. "21.0.7" */ }
/** Mojang runtime manifest -> platform key (paths.mojangPlatformKey) -> JAVA_RUNTIME_COMPONENT.
 *  Installs into paths.java. Fast path: if <paths.java>/release has JAVA_VERSION and the executable
 *  exists, return without network. Otherwise install with installJavaRuntimeTask, chmod 0755 on
 *  mac/linux is handled by the library (verify), then spawn `java -version` and check "21.". */
export function ensureJava(paths: LauncherPaths, report: ProgressReporter, opts?: { log?: (l: string) => void }): Promise<JavaInstall>
```

### `vanilla.ts`
```ts
/** Resolves the version through version_manifest_v2.json every time (never hardcode the package
 *  URL), installs json + client jar + libraries + assets into paths.minecraft with installTask,
 *  reporting bytes/files progress. On re-run the library validates existing files by hash. */
export function ensureVanilla(paths: LauncherPaths, mcVersion: string, report: ProgressReporter, opts?: { log?: (l: string) => void }): Promise<ResolvedVersion>
```

### `neoforge.ts`
```ts
/** Version id is `neoforge-${neoVersion}`. Gate: the 4 runtime artifacts under paths.minecraft/libraries
 *  (client-<mc>-<neoform>-srg.jar, -extra.jar, neoforge-<v>-client.jar, neoforge-<v>-universal.jar; find
 *  the neoform version from versions/<id>/<id>.json arguments --fml.neoFormVersion, or by globbing
 *  libraries/net/minecraft/client/<mc>-*) plus versions/<id>/<id>.json. When all present, return
 *  immediately. Otherwise run installNeoForgedTask('neoforge', neoVersion, folder, { java: javaPath,
 *  inheritsFrom: mcVersion }) with progress, then re-check the gate and throw if still missing. */
export function ensureNeoForge(paths: LauncherPaths, mcVersion: string, neoVersion: string, javaPath: string, report: ProgressReporter, opts?: { log?: (l: string) => void }): Promise<string /* version id */>
```

### `launch.ts`
```ts
export interface LaunchRequest {
  paths: LauncherPaths
  instanceId: string
  versionId: string          // 'neoforge-21.1.250'
  javaPath: string
  preset: LaunchPreset
  profile: { name: string; id: string }
  accessToken: string
  xuid?: string
  clientId?: string
  server?: { host: string; port?: number }   // quickPlayMultiplayer
  demo?: boolean             // adds --demo; used only by the dev smoke test
  log?: (line: string) => void
}
/** Writes preset.optionsOverrides into <instance>/options.txt (merge, keep other keys), builds
 *  options for @xmcl/core launch(): gamePath = instance dir, resourcePath = paths.minecraft,
 *  maxMemory = preset.maxMemoryMb, extraJVMArgs = preset.extraJvmArgs, userType 'msa',
 *  spawn with windowsHide, pipes stdout/stderr to <paths.logs>/game-latest.log (truncate on start)
 *  and to opts.log. Returns the ChildProcess. */
export function launchGame(req: LaunchRequest): Promise<ChildProcess>
export function defaultPreset(totalMemoryBytes: number): LaunchPreset   // 16 GB -> 6144, 8 GB -> 4096, else clamp 2048..8192 at 40% of RAM
export function lowPreset(): LaunchPreset                                // 3072 MB, renderDistance 6, graphics fast, no fancy leaves/clouds
```

### `pack.ts`
```ts
export interface SyncOptions {
  paths: LauncherPaths
  instanceId: string
  baseUrl: string            // must end with '/', pack.toml lives at baseUrl + 'pack.toml'
  side: 'client' | 'server'
  report: ProgressReporter
  resolveOptions?: (options: PackOption[]) => Record<string, boolean>   // wins over enabledOptions
  enabledOptions?: Record<string, boolean>   // optional-mod choices keyed by metafile path; default = option.default
  signal?: AbortSignal
  log?: (line: string) => void
}
/** packwiz 1.1.0 consumer. pack.toml -> check pack-format starts with 'packwiz:' and major 1 ->
 *  fetch index (pack.index.file) and verify its hash (pack.index.hash, hash-format) -> for each
 *  [[files]] entry: skip wrong side and disabled optionals; metafile entries: fetch the .pw.toml,
 *  verify its hash against the index entry, download [download].url (mode 'url' only; throw a
 *  clear error for metadata:curseforge) to <instance>/<dir of .pw.toml>/<filename>; plain entries:
 *  download baseUrl + file to <instance>/<file>; honor preserve (skip if exists); verify every file
 *  with the listed hash-format (sha1/sha256/sha512/md5); delete files that were in the previous
 *  state but vanished from the plan (left the pack or turned off); persist state to
 *  <paths.state>/sync-<instanceId>.json { packHash, indexHash, options, optionList, skipped,
 *  files: { [relPath]: { hash, hashFormat, optional, preserved, source } } }.
 *  Optional entries: [option] optional/default/description of every metafile of this side make
 *  the option list (PackOption[], index order). The resolver runs on that list (fresh on a full
 *  pass, from state.optionList on the short-circuit path) and its record is what planFiles reads
 *  and what the state stores as `options`.
 *  Short-circuit: when the sha256 of the fetched pack.toml equals state.packHash, index.hash equals
 *  state.indexHash and resolveOptions(state.optionList) equals state.options, verify only presence
 *  of files and return unchanged=true. A state without optionList (written before 0.3.0) never
 *  short-circuits. Fetch pack.toml with cache: 'no-store'. Concurrency 6. */
export function syncPack(o: SyncOptions): Promise<SyncResult>       // SyncResult.options = the option list
/** The option list for the UI: state.optionList when a state exists (no network), else pack.toml +
 *  index + every metafile. Never writes anything. */
export function readPackOptions(paths: LauncherPaths, instanceId: string, baseUrl: string, side: 'client' | 'server', opts?: { signal?: AbortSignal; log?: (l: string) => void }): Promise<PackOption[]>
export function readPackVersions(baseUrl: string): Promise<{ minecraft: string; neoforge: string }>
/** launcher.json: schemaVersion 1, minLauncherVersion, server, motd, news, plus the optional
 *  lowPresetDisables (string[]) and optionRequires (record) fields, empty when absent or malformed. */
export function readLauncherJson(baseUrl: string): Promise<LauncherJson>
```

### `settings.ts`
```ts
export function loadSettings(paths: LauncherPaths, opts?: { log? }): Promise<Settings>   // default { preset: 'default' }
export function saveSettings(paths: LauncherPaths, s: Settings): Promise<void>            // writes normalizeSettings(s)
export function presetFor(settings: Settings, totalMemoryBytes: number): LaunchPreset
/** Keeps preset, maxMemoryMb (clamped 2048..12288) and options ("<path>.pw.toml": boolean pairs only). */
export function normalizeSettings(raw: unknown): Settings
/** Re-exported from src/shared/options.ts (pure, no Node, also used by the renderer): every optional
 *  entry with its effective value = stored choice, else PackOption.default; then the low preset holds
 *  rules.lowPresetDisables off and rules.optionRequires holds an entry off while its requirement is off
 *  (chains followed to a fixed point). One log line per rule key absent from the option list. */
export function effectiveOptions(settings: Settings, packOptions: PackOption[], rules: OptionRules, log?): Record<string, boolean>
export function resolveOptions(settings: Settings, packOptions: PackOption[], rules: OptionRules, log?): ResolvedOption[]   // + lock reason per entry, for the UI
```

### `auth.ts`
```ts
export interface StoredTokens { refreshToken: string; msClientId: string }
export interface TokenStore { load(): Promise<StoredTokens | null>; save(t: StoredTokens): Promise<void>; clear(): Promise<void> }
export interface Session { profile: { id: string; name: string }; accessToken: string; expiresAt: number; xuid?: string }
export interface AuthOptions {
  clientId: string
  store: TokenStore
  openExternal: (url: string) => Promise<void>   // system browser
  log?: (line: string) => void
  fetch?: typeof fetch
}
/** Authorization code + PKCE (S256) against MS_AUTHORITY, scope MS_SCOPE, loopback redirect on
 *  127.0.0.1 with an ephemeral port advertised as http://localhost:<port> (Entra ignores the port),
 *  prompt=select_account, state check, 5-minute timeout, a small HTML page telling the player they
 *  can close the tab. Then @xmcl/user MicrosoftAuthenticator: acquireXBoxToken(msAccessToken) ->
 *  loginMinecraftWithXBox(uhs, xstsToken) -> MojangClient.getProfile / checkGameOwnership.
 *  Map errors to readable messages: XErr 2148916233 (no Xbox profile), 2148916238 (child account),
 *  2148916229, HTTP 403 "Invalid app registration" (app not yet approved by Mojang: show the
 *  message verbatim), profile NOT_FOUND (Game Pass / no Java profile yet). */
export function loginInteractive(o: AuthOptions): Promise<Session>
export function loginSilent(o: AuthOptions): Promise<Session | null>   // from stored refresh token; null when none/invalid
export function logout(o: AuthOptions): Promise<void>
export class AuthError extends Error { code: 'not-approved' | 'no-xbox-profile' | 'child-account' | 'no-java-profile' | 'not-owned' | 'cancelled' | 'network' | 'unknown' }
```

## Smoke scripts (in `scripts/`, run with `npx tsx`)

- `smoke-install.ts <root>`: ensureJava -> ensureVanilla('1.21.1') -> ensureNeoForge('1.21.1','21.1.250') twice; the second pass must complete in < 3 s and log "cached". Prints `OK: neoforge-21.1.250 ready`.
- `smoke-pack.ts <root>`: syncPack from `PACK_BASE_URL` into instance `consortium`, twice; second pass unchanged=true; then simulate a removed file by editing the state and check it is re-downloaded; a state without option list forces a full pass; runs 7 to 9 enable Iris through `effectiveOptions` (one jar downloaded, its name taken from the state entry whose `source` is the Iris metafile), force it off with the low preset rule (one jar removed) and short-circuit on the cached option list. Prints `OK: <n> files`.
- `smoke-settings.ts`: `normalizeSettings` and the optional-mod rule (`effectiveOptions` / `resolveOptions`): defaults, choices, low preset, requirement chains and cycles, warnings for rule keys the pack does not have. No network. Prints `OK: settings helpers`.
- `smoke-launch.ts <root>`: after smoke-install and smoke-pack, launchGame with demo=true, a placeholder profile and token, waits until <paths.logs>/game-latest.log contains "Loading" from NeoForge or 60 s elapse, then kills the process. Prints `OK: game started (NeoForge <v>, <n> mods)` when the game log mentions the loader and the mod count.
- `smoke-auth.ts`: unit-tests the PKCE helpers (verifier/challenge S256 against a known vector) and the loopback server (start, GET /?code=x&state=y, receives the code, closes), with a fake token endpoint via the injected `fetch`. Prints `OK: auth helpers`.

## Implementation notes (2026-09-14, after review)

Deviations from the API text above that were accepted during implementation and review:

- `download.ts` also exports `fetchBytes`, `hashBytes`, `userAgent`, `DownloadFailure`; `DownloadError`
  carries `reason` ('policy' | 'network' | 'status' | 'checksum' | 'content' | 'cancelled' | 'disk') and
  `status`. Redirects are followed manually (max 5 hops) and every hop is checked against the host
  allow-list. Local filesystem errors (ENOSPC, EACCES, EISDIR...) are never retried.
- `pack.ts` exports `PackError`; `SyncOptions` accepts `signal`. The state file also stores `options`,
  `skipped` and a per-file `source`, which the short-circuit needs to prove the state still covers the
  index in both directions. `SyncResult.skipped` counts files that needed no download.
- `java.ts` performs the mac/linux `chmod 0755` and creates the manifest `link` entries itself
  (`@xmcl/installer` 6.1.2 ignores both) and writes a `.verified` marker after a successful
  `java -version`, so an interrupted runtime download is repaired instead of trusted.
- `vanilla.ts` re-validates json, jar and libraries by sha1 on every run; assets are size-checked once a
  full validation pass has completed (a marker records it), because hashing 825 MB of assets costs
  1.5 s per Play click.
- `neoforge.ts` gate also verifies every library of the resolved NeoForge version, not only the 4
  processor outputs.
- `launch.ts`: `userType` is omitted (the library defaults to msa and its type does not list it);
  `-Dlog4j.configurationFile` is dropped so `game-latest.log` stays readable; `launchGame` resolves only
  after the process is confirmed started (spawn errors reject).
- `settings.ts`: `loadSettings(paths, opts?)`; `saveSettings` sanitizes values.
- `auth.ts`: `new AuthError(message, code, { cause? })`. `@xmcl/user` also calls
  `device.auth.xboxlive.com` and a second XSTS authorize for `http://xboxlive.com` (source of the xuid).
- Electron glue (auto-update, token store) lives in `src/main/electron/`, not in core.

## Implementation notes (2026-09-16, launcher 0.3.0: optional mods)

- `src/shared/types.ts` gained `PackSide`, `PackOption { file, name, description?, default, side }`,
  `OptionRules { lowPresetDisables, optionRequires }` (which `LauncherJson` extends, both always
  present and empty when the file has none), `SyncResult.options: PackOption[]` and
  `Settings.options?: Record<string, boolean>` (choices keyed by metafile path).
- `src/shared/options.ts` is a second shared module (pure, no Node or Electron import): the
  optional-mod rule must be identical in the Play handler, the smoke tests and the renderer's
  checkbox card, so it lives where both tsconfigs compile it. `settings.ts` re-exports it.
- `pack.ts`: `parseMetafile` reads `[option].description`; `SyncOptions.resolveOptions` is the
  preferred input (`enabledOptions` stays as the trivial resolver); the state file stores
  `optionList` next to `options`; `readPackOptions` serves the UI from that cache.
- `launcher.json` (pack repo) gained two optional fields read by `readLauncherJson` and ignored by
  older launchers: `lowPresetDisables: ["mods/iris.pw.toml"]` and
  `optionRequires: { "shaderpacks/<pack>.pw.toml": "mods/iris.pw.toml" }`. The rule is data on
  purpose: a renamed metafile makes `effectiveOptions` log the drift instead of silently dropping
  the rule.
- `ipc.ts` loads settings and `launcher.json` before `syncPack` and passes
  `resolveOptions: (list) => effectiveOptions(settings, list, launcherJson, log)`; new handler
  `pack:options` (preload `getPackOptions()`) returns `[]` on failure. `config.ts` and `paths.ts`
  are untouched.
- The first Play after the upgrade does one full pass: the previous state has no `optionList`.
