# Consortium Launcher

A small, open-source desktop launcher for **The Consortium**, a private, invite-only modded
Minecraft: Java Edition server (NeoForge 1.21.1) for roughly 15-25 players.

> **NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.**

This notice is also displayed inside the launcher (sign-in screen and footer), in the repository
description, and in every release's notes.

Its only job is to make joining one server painless: sign in with the player's own Microsoft
account, install the exact game, loader and mod versions the server runs, keep them up to date,
and start the game. It replaces the manual "download this modpack zip, put these 70 jars in the
right folder, install this NeoForge version" routine, and nothing more. Using it is optional: an
invited player who installs the same NeoForge version and mods by hand can join with the
official Minecraft Launcher in exactly the same way.

## Responsible party and contact

- **Owner and maintainer:** underfr (https://github.com/underfr), on behalf of The Consortium
  server administrators. We, not Mojang or Microsoft, are responsible for this launcher, for the
  server, and for all player data handled by either.
- **Contact:** contact.consortiummc@gmail.com (the same address given on Mojang's AppID form). Bug reports and
  feature requests may additionally be filed as GitHub issues on this repository.

## Implementation status

The sections below describe the design and the commitments this project is built around. This
table shows what is actually implemented on `main` today.

| Feature | Status | Where |
|---|---|---|
| Electron/React application shell, in-app disclaimer | implemented | `src/` |
| Self-update on start (GitHub Releases, `electron-updater`, differential downloads) | implemented and verified end to end (v0.1.0 to v0.1.1) | `src/main/electron/update.ts` |
| Java 21 provisioning from Mojang's runtime manifest | implemented, smoke-tested | `src/main/core/java.ts` |
| Vanilla install from Mojang's servers with SHA-1 verification | implemented, smoke-tested | `src/main/core/vanilla.ts` |
| NeoForge install via the official installer | implemented, smoke-tested | `src/main/core/neoforge.ts` |
| packwiz modpack sync | implemented, smoke-tested against the live pack | `src/main/core/pack.ts` |
| Microsoft sign-in (auth code + PKCE) and Xbox Live / XSTS / Minecraft Services chain, entitlement and profile checks | implemented; unit-tested with stubbed endpoints, end-to-end test blocked on Mojang AppID approval | `src/main/core/auth.ts` |
| Game launch | implemented; NeoForge 21.1.250 boots with the test mods | `src/main/core/launch.ts` |
| Low RAM / low graphics preset | implemented | `src/main/core/settings.ts` |
| Code-signed release builds | planned | see "Updates and signing" |

## Microsoft application registration

The launcher signs in with its own Microsoft Entra application:

- Display name (what players see on Microsoft's consent screen): **Consortium Launcher**
- Publisher: underfr
- Application (client) ID: `c59d3724-2960-47b2-8d24-95130e9063e9` (public-client ID, not a secret)
- Tenant: `consumers` (personal Microsoft accounts only), public client, no client secret
- OAuth scopes requested: `XboxLive.signin offline_access`
- Redirect URI: loopback `http://localhost:<ephemeral port>`, registered under "Mobile and
  desktop applications"; Microsoft's sign-in page is only ever opened in the player's system
  browser, never in an embedded web view

This is the only client ID present in the source or used by any build. Development builds do not
borrow another launcher's application ID; sign-in simply fails until Mojang approves this one
through the AppID review (https://aka.ms/mce-reviewappid). Forks must register and submit their
own application ID and must not reuse ours. The constant lives in `src/main/core/config.ts`.

### Why this launcher needs Minecraft Services API access

After Microsoft and Xbox Live sign-in, the launcher must call `api.minecraftservices.com` to
(a) verify that the account owns Minecraft: Java Edition before anything is launched and
(b) obtain the session token the game itself needs to join an online-mode server. Without that
access the launcher cannot enforce ownership and cannot start the game at all; there is no
fallback path.

## Design and commitments

### Sign-in and ownership

- Standard Microsoft identity platform flow: authorization code + PKCE (S256) against
  `login.microsoftonline.com/consumers`, then the same Xbox Live to XSTS to Minecraft Services
  token exchange third-party launchers use (`user.auth.xboxlive.com`, `xsts.auth.xboxlive.com`
  with relying party `rp://api.minecraftservices.com/`,
  `api.minecraftservices.com/authentication/login_with_xbox`), followed by the
  `entitlements/mcstore` and `minecraft/profile` checks. Every request goes directly from the
  player's machine to Microsoft or Mojang; no proxy or server of ours is in the path.
- Players must own Minecraft: Java Edition. If the account has no Java Edition entitlement or no
  profile, the launcher explains why, links to minecraft.net, and will not start the game. There
  is no offline mode, no username-only login, no offline UUIDs, and no way to skip this check.
- The launcher starts the unmodified game with the standard `--accessToken`, `--uuid`, `--xuid`,
  `--clientId` and `--userType msa` arguments. It never sets `-Dminecraft.api.*` properties,
  never loads authlib-injector or any Java agent, never runs or points to a third-party or
  self-hosted authentication server, and never redirects or intercepts the game's session,
  services or auth hosts. Once started, the game authenticates against Mojang's session servers
  exactly as it does under any other launcher.

### Game files and mods

- The game is downloaded only from Mojang's authorized distribution endpoints, as the EULA
  requires: version manifest, client jar, libraries and assets come from `piston-meta`,
  `piston-data`, `libraries.minecraft.net` and `resources.download.minecraft.net`, verified
  against Mojang's SHA-1 hashes, straight onto the player's machine. This project never bundles,
  mirrors, re-hosts or redistributes any Mojang file, code or asset.
- No pre-patched or modified client is ever shipped, hosted or mirrored by this project.
  NeoForge's own installer, downloaded from `maven.neoforged.net`, applies its patches locally on
  the player's machine to the client jar the player downloaded from Mojang, which is exactly what
  happens when a player runs that installer by hand. Nothing patched ever leaves the player's
  computer.
- The modpack is described by a public packwiz manifest maintained at
  https://github.com/underfr/consortium-pack. It contains only third-party mods, configuration
  files and scripts written by us. It contains no Mojang code or assets and no altered vanilla
  files. Each mod is downloaded from its author's chosen distribution channel (Modrinth CDN, FTB
  Maven) under that author's own license and terms; nothing is re-hosted.
- Java 21 is provisioned from Mojang's published runtime manifest, so players install nothing
  else.

### Safety features

- The launcher does not change any of the game's own safety or reporting features: chat
  signing, player reporting, game telemetry and online-safety settings are left untouched, and
  no launch argument or configuration shipped by this project disables them. The modpack contains
  no mod that disables or circumvents chat reporting or secure chat.
- The launcher does not hide or alter any of Minecraft's own dialogs, EULA prompts, warnings or
  error messages.
- The only game setting the launcher writes is the optional "low RAM / low graphics" preset,
  which sets the JVM heap size and a handful of `options.txt` graphics values (render distance,
  graphics quality). Nothing else in the game's configuration is touched.

### Server rules

- The server runs with `online-mode=true` and a server-side whitelist, so every connection is
  verified against Mojang's session servers regardless of which launcher is used. The launcher's
  own entitlement check is a convenience, not the enforcement point.
- The launcher sells nothing and contains no purchase or donation flow. Server access is free
  and by invitation. The in-game economy is entirely virtual.

### Privacy

- The launcher never sees the player's password: sign-in happens in the system browser on
  Microsoft's pages.
- The Microsoft refresh token is stored locally with the operating system's protected storage
  (Windows DPAPI, macOS Keychain, Linux secret-service keyring, through Electron `safeStorage`)
  and is only ever sent to Microsoft's token endpoint. On Linux, if no keyring is available, the
  launcher does not persist the token and asks the player to sign in again next time rather than
  storing it unencrypted. The short-lived Minecraft access token is held in memory and passed to
  the game process only. Tokens are never logged.
- The launcher process contains no telemetry, analytics, crash reporting or advertising and
  contacts only the endpoints listed below. Local logs contain install and launch diagnostics
  only; players can export them to get help, nothing is uploaded automatically.

## Network endpoints

| Purpose | Host |
|---|---|
| Microsoft sign-in | `login.microsoftonline.com` |
| Xbox Live / XSTS | `user.auth.xboxlive.com`, `xsts.auth.xboxlive.com` |
| Minecraft Services (login, entitlements, profile) | `api.minecraftservices.com` |
| Game files (version manifest, client, libraries, assets, Java runtime) | `piston-meta.mojang.com`, `piston-data.mojang.com`, `launchermeta.mojang.com`, `libraries.minecraft.net`, `resources.download.minecraft.net` |
| NeoForge | `maven.neoforged.net` |
| Mods | `cdn.modrinth.com`, `maven.ftb.dev` |
| Modpack manifest | `underfr.github.io` (GitHub Pages) |
| Launcher updates | `github.com`, `objects.githubusercontent.com` |
| Game process (not the launcher), unchanged vanilla behaviour | `sessionserver.mojang.com`, `api.minecraftservices.com`, Mojang telemetry endpoints |

Launcher downloads are HTTPS only and restricted to this allow-list in code.

## Updates and signing

The launcher checks GitHub Releases on every start through `electron-updater`. Updates are
fetched over HTTPS and verified against the SHA-512 published in the release manifest before
being applied. Release builds are not yet code-signed (Windows Authenticode and macOS
notarization are planned); until then Windows shows its standard SmartScreen prompt on the first
manual install.

## Branding

The launcher's name, icon, user interface, repository artwork and release listings use none of
Mojang's or Microsoft's brand assets: no Minecraft logo or logo-style lettering, no Minecraft
font, no game textures or marketing artwork. "Minecraft" is never the dominant part of the
launcher's name.

## Building from source

Requirements: Node.js 24, npm.

```bash
npm install
npm run typecheck
npm run build      # compiles main / preload / renderer into out/
npm run dev        # development mode with hot reload
npm run dist       # builds installers into dist/ without publishing
```

Stack: TypeScript, Electron, React, [`@xmcl/core`](https://github.com/Voxelum/x-minecraft-launcher)
and `@xmcl/installer` (MIT) for the Minecraft install and launch logic, `@xmcl/user` for the
Xbox Live / Minecraft Services steps, `electron-updater` for self-update. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and milestones.

## The server

*The Consortium* is a season-based industrial server with a virtual in-game economy (Create,
Mekanism, Applied Energistics 2) for an English-speaking community. Access is free, by
invitation, and requires a genuine Minecraft: Java Edition account.

## License and trademarks

The source code of this project is released under the [MIT License](LICENSE). The license
covers only this project's own code; the repository and its releases contain no Mojang code or
assets.

Minecraft is a trademark of Microsoft Corporation; Minecraft game content is copyright Mojang AB.
This project is an independent community tool. It is not an official Minecraft product and is
not approved by, endorsed by, associated with, supported by or connected to Mojang or Microsoft.
It is built to comply with the [Minecraft EULA](https://www.minecraft.net/eula) and the
[Usage Guidelines](https://www.minecraft.net/usage-guidelines), and the maintainers will change
or withdraw it if Mojang or Microsoft ask.
