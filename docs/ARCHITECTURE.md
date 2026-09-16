# Consortium Launcher - architecture decision (2026-09-14)

> Snapshot of the project-level design doc. Research citations refer to checks made on 2026-09-14.

> Research basis: 8 verified investigations (Helios Launcher, @xmcl libs, CmlLib.Core, Microsoft auth rules, packwiz,
> headless NeoForge install, Electron distribution/signing, Java 21 provisioning) + a 3-perspective panel
> (ship-fast / robust / player-UX). All three perspectives independently recommended the same stack.

## 1. Decision

| Layer | Choice | Why |
|---|---|---|
| Language / runtime | **TypeScript on Electron 44.x** (Node 24 in main process) | Dev has Node 24, no Rust; the only stack verified end-to-end on this machine. |
| Scaffold / UI | **electron-vite 5 (react-ts template)**, React 19, thin renderer over typed IPC (contextIsolation on, sandbox on, nodeIntegration off) | Standard, maintained, HMR. No @electron/remote, no jQuery. |
| Minecraft engine | **`@xmcl/core@2.15.1` + `@xmcl/installer@6.1.2` - EXACT pins, no caret** | Verified 2026-09-14 on Node 24: installs vanilla 1.21.1, installs NeoForge 21.1.250 (runs processors), installs Mojang Java 21 (`java-runtime-delta` 21.0.7), resolves `inheritsFrom`, generates correct `-p` module path + `--fml.*` args. **`latest` (core 2.16.1 / installer 6.3.x) is broken on npm** (workspace deps, missing `@xmcl/core/utils`; issue Voxelum/x-minecraft-launcher#1746). Wrapped behind our own `core/install.ts` interface so we can swap to the official installer subprocess (`--install-client`, also verified) if needed. |
| Microsoft login | **Hand-rolled Authorization Code + PKCE (S256), system browser, ephemeral-port `http://localhost` loopback**, then `@xmcl/user@4.4.2` `MicrosoftAuthenticator` for Xbox Live → XSTS → Minecraft services → entitlements → profile. Device-code flow as fallback later. Refresh token stored with Electron `safeStorage` (DPAPI/Keychain). | Best UX, no heavy dependency, documented endpoints (minecraft.wiki, 2026-09-02). |
| Pack manifest | **Consume the packwiz 1.1.0 format** (`pack.toml` → `index.toml` → `*.pw.toml`), authored with the packwiz CLI, hosted on **GitHub Pages** (public repo, `.nojekyll`, `.gitattributes * -text`). Our own downloader (~250 lines, `smol-toml`), never `packwiz-installer`. Plus a tiny `launcher.json` next to it: server address, MOTD, minimum launcher version, news. | Mature authoring CLI (`packwiz modrinth install`, `packwiz update --all`, `packwiz refresh`), stable spec since 2023, git-friendly, exports to `.mrpack` for players who insist on Prism/Modrinth App, same pack drives the server (`-s server`, itzg docker `PACKWIZ_URL`). |
| Mod sources | **Modrinth CDN + FTB Maven only** (see `MODLIST.md` §5). No CurseForge API key, no manual-download fallback. | 100 % of the chosen mods are available that way. |
| Java 21 | Mojang runtime manifest (`all.json` → platform → `java-runtime-delta`), per-file sha1, self-repairing; `chmod 0755` on mac/Linux for `executable: true` files. Adoptium as opt-in fallback. | Identical JDK to the vanilla launcher. |
| NeoForge | Version pinned in `pack.toml` (`[versions] neoforge = "21.1.250"`). Install gated on presence of the 4 runtime artifacts (`client-1.21.1-<neoform>-srg.jar`, `-extra.jar`, `neoforge-<ver>-client.jar`, `-universal.jar`) - never re-run at every launch (no processor cache in 21.1.x: ~26 s + 9.6 MB mappings download each time). | Verified. |
| Self-update | **electron-builder `@v26` (26.16.1) + electron-updater 6.8.9**, provider GitHub Releases (`releaseType: release`), tag-triggered GitHub Actions on windows/ubuntu/macos runners (free for a public repo). `autoUpdater.checkForUpdatesAndNotify()` at every start. Per-user NSIS one-click (no UAC, differential updates). | Verified from source. |
| Code signing (v1) | **Windows: unsigned** (players click *More info → Run anyway* once; subsequent auto-updates carry no Mark-of-the-Web). **macOS: only if ≥ 2 Mac players → Apple Developer $99/yr + notarization** (mandatory for Squirrel.Mac auto-update; Sequoia removed the Ctrl-click bypass). Linux: AppImage, unsigned. | EV certs no longer bypass SmartScreen (2024); Azure Artifact Signing not available to EU individuals. |
| Low-RAM preset | Launcher-side: `-Xmx3G` + `options.txt` overlay (render distance 6, graphics fast, no shaders, Iris optional mod off). Files marked `preserve = true` in packwiz so sync never clobbers them. Default preset: 16 GB → `-Xmx6G`, 8 GB → `-Xmx4G`; Mojang G1 flags (`-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M`). | Never omit `-Xmx` (JVM ergonomics cap at 25 % RAM). |

Rejected: **Helios Launcher** (zero NeoForge support at 4 layers, single maintainer, ~5 commit-days in 18 months, re-hosts patched client jars = DMCA risk), **CmlLib.Core/.NET** (viable, but default Microsoft login is WebView2/Windows-only; NeoForge package is a 3-release third-party fork; CmlLib.Core no code commit since 2025-10), **Tauri** (needs Rust + MSVC, no delta updates, minisign key-loss risk, solves nothing about signing).

## 2. Legal red lines (EULA + Usage Guidelines + AppID review form, verified)

- Never bundle or re-host `client.jar`, libraries, assets or a patched/modded client. Download from Mojang's CDN at runtime, verify SHA-1.
- Keep the real Microsoft login; check entitlements + profile; **no offline/cracked mode**. Server stays `online-mode=true`.
- App name must **not** contain Minecraft/Mojang/Microsoft/Xbox/Live/Discord/Hypixel → **"Consortium Launcher"**.
- No Mojang/Microsoft logos. Disclaimer on launcher, download page and README: *"NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT."*
- Only redistribute mods whose licences allow it (all chosen mods are fetched from their official CDN, not re-hosted).

## 3. ⚠ Critical path - do this today (admin, ~20 min + 1-3 weeks of waiting)

The Minecraft services API rejects every new Azure app until Mojang manually allow-lists it (HTTP 403 *"Invalid app registration"* on `login_with_xbox`; Microsoft login, Xbox and XSTS steps still succeed). Reviews are weekly; observed turnaround 1-2 weeks; a single submission only.

0. **Prerequisite - own an Entra tenant.** A bare personal Microsoft account (outlook/hotmail/live) has none: entra.microsoft.com / portal.azure.com park it in the system tenant "Microsoft Services" and show *"The selected user account does not exist in tenant 'Microsoft Services' and cannot access the application '74658136-…'"* (AADSTS50020, Cause 1 on Microsoft Learn, updated 2026-01-28 - expected behaviour, the old auto-created directory was removed). The only Microsoft-documented fix (verified 2026-09-14): in an **InPrivate window**, go to https://azure.microsoft.com/fr-fr/pricing/purchase-options/azure-account → *Essayer Azure gratuitement*, sign in with the **same** personal account, Country = France (must match the card's billing address), phone verification, then **card verification with a non-prepaid, non-virtual credit or debit card** (~1 € temporary hold, released; nothing is charged for a free account; Learn "Microsoft Entra ID Free": *"we require a credit card to verify your identity… Your credit card isn't charged"*). A workforce tenant "Default Directory" (`<alias>.onmicrosoft.com`) is generated with you as Global Administrator. **Never upgrade to pay-as-you-go**; when the 30-day/$200 credit ends the subscription is simply disabled - the tenant and app registration persist (Entra ID Free cannot be cancelled). Keep that disabled subscription (deleting the last one makes the portal fall back to "Microsoft Services" again). Do **not** create an "External" (External ID / CIAM) tenant - wrong type, cannot host personal-account apps. Card-free exceptions only: Azure for Students (academic e-mail) or being invited as admin into a friend's tenant. Unverified 2-minute trick to try first (rclone forum, 2025): fill only page 1 of the sign-up form, tick the box, click *Next* - some users report the directory is created before the card step.
1. https://entra.microsoft.com (check the top-right shows your new directory, not "Microsoft Services"; gear icon → *Directories + subscriptions* to switch) → App registrations → **New registration**: name **Consortium Launcher**; supported account types: **Personal Microsoft accounts only**; no redirect URI at creation.
2. Authentication → Add a platform → **Mobile and desktop applications** → redirect URI `http://localhost` (Entra ignores the port for localhost). Advanced settings → **Allow public client flows = Yes**. **No client secret** (public client).
3. Copy **Application (client) ID** and **Directory (tenant) ID** from Overview.
4. Submit https://aka.ms/mce-reviewappid : *New AppID for Approval*; contact e-mail = the Azure account's e-mail; app name; client ID; tenant ID; a public URL (GitHub repo README of the launcher is enough); justification ("private modded server launcher for ~25 players, uses standard MS/Xbox/Minecraft auth, no bypass").
5. Wait. Meanwhile everything else can be built and tested up to the XSTS step; the 403 body is surfaced verbatim in the UI/log.

## 4. Repository layout (two public GitHub repos)

```
consortium-launcher/           (Electron app, MIT, GitHub Releases = update channel)
  src/main/       core/{download,java,vanilla,neoforge,launch,auth,pack,settings,update}.ts, ipc.ts, index.ts
  src/preload/    typed bridge
  src/renderer/   React UI (single screen: account, Play, progress, preset toggle, news)
  electron-builder.yml, .github/workflows/release.yml
consortium-pack/               (packwiz pack, GitHub Pages = pack URL)
  pack.toml, index.toml, mods/*.pw.toml, config/, kubejs/, launcher.json, .nojekyll, .gitattributes
```

On-disk layout on the player's machine (`%APPDATA%/consortium-launcher/`):
`runtime/java21/`, `minecraft/{versions,libraries,assets}/` (shared, hash-verified), `instances/consortium/{mods,config,kubejs,saves,options.txt}`, `state/{sync-state.json,settings.json,auth.bin}`, `logs/`.

## 5. Milestone 1 - "boots NeoForge 1.21.1 with 2 test mods from the remote manifest, and picks up a manifest change on next launch"

| # | Step | Est. |
|---|---|---|
| 0 | Entra app + Mojang form (§3) | 20 min + wait |
| 1 | Scaffold electron-vite react-ts; pin exact deps; `npm run build` green | DONE 2026-09-14 (commit c37af6b) |
| 2 | Prove the **self-update channel first** (v0.1.0 → v0.1.1 via GitHub Release + Actions) - the one thing you cannot fix remotely if it ships broken | DONE 2026-09-14: v0.1.0 and v0.1.1 built by CI on win/mac-arm64/linux and published with the disclaimer in the notes; installed v0.1.0 found 0.1.1, downloaded a differential update (822 KB of 118 MB via blockmap), installed silently and relaunched as 0.1.1 |
| 3 | `core/download.ts`: https-only host allowlist, `.part` + atomic rename, sha1/256/512 verify, retry, concurrency 8 | DONE 2026-09-14 (manual redirect following, allow-list per hop, disk errors not retried) |
| 4 | `core/java.ts`: Mojang runtime manifest → Java 21 install, `java -version` sanity check | DONE 2026-09-14 (chmod + symlinks done by us, .verified marker) |
| 5 | `core/vanilla.ts`: resolve 1.21.1 via `version_manifest_v2.json` (never hardcode the package URL - Mojang re-published 1.21.1.json on 2026-09-14), json + jar + libraries + assets | DONE 2026-09-14 |
| 6 | `core/neoforge.ts`: gated `installNeoForged('neoforge', ver, mc, {java, inheritsFrom})`, verify the 4 artifacts | DONE 2026-09-14 (gate also checks the version libraries) |
| 7 | `core/launch.ts`: `Version.parse` + `launch({gamePath, resourcePath, javaPath, maxMemory, extraJVMArgs, quickPlayMultiplayer})`, `javaw.exe` on Windows, log capture | DONE 2026-09-14 (boots NeoForge 21.1.250 + test mods in demo mode) |
| 8 | Pack repo: `packwiz init --mc-version 1.21.1 --modloader neoforge --neoforge-version 21.1.250`, install 2 test mods (e.g. `jei`, `jade`), push to Pages | DONE 2026-09-14 (github.com/underfr/consortium-pack, served from raw.githubusercontent.com until Pages is enabled) |
| 9 | `core/pack.ts`: pack.toml → pack-format check → index.toml hash → per-file diff vs `sync-state.json` → side/option/preserve → download → delete vanished files; short-circuit when hashes unchanged | DONE 2026-09-14 (6-scenario smoke test) |
| 10 | `core/auth.ts`: PKCE loopback + XBL/XSTS/MC chain + entitlement/profile + safeStorage refresh token; readable errors for XErr 2148916233/2148916238 and NOT_FOUND profile (Game Pass) | DONE 2026-09-14 (stubbed end-to-end test; real login waits for Mojang approval) |
| 11 | UI: account chip, Play, phase-labelled progress, Low-RAM toggle, news/MOTD from `launcher.json`, "export diagnostics" zip | DONE 2026-09-14 (v0.2.0) |
| 12 | Acceptance on a clean second Windows machine: install from GitHub Release → login → Play → NeoForge starts with the 2 mods → add a 3rd mod to the pack → relaunch → it appears | 1 d |

Total ≈ **10-12 days of part-time work**, auth step gated by Mojang approval.

Observed during step 2: the `macos-latest` runner is Apple Silicon, so only arm64 macOS artifacts are produced; add `arch: [x64, arm64]` to `mac.target` if any player has an Intel Mac. Release assets with spaces get renamed with dots by GitHub (`Consortium.Launcher-...`), which electron-updater handles.

Milestone 2 (after M1): Ed25519-signed `pack.toml`/`launcher.json` (fail-closed; `node:crypto` built-in), optional-mod checkboxes UI (DONE 2026-09-16, v0.3.0: `[option]` entries listed with their description, choices in `settings.json`, low preset and requirement rules read from `launcher.json`), device-code auth fallback, macOS signing decision, Discord RPC, server status ping.
