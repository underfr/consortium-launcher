// Central constants for the launcher. Everything remote-configurable lives in the
// pack repo (launcher.json / pack.toml); only bootstrap values are hardcoded here.

/** Base URL of the packwiz pack (GitHub Pages). Must end with a slash. */
export const PACK_BASE_URL = 'https://underfr.github.io/consortium-pack/'

/**
 * Entra application (client) ID of the "Consortium Launcher" app registration.
 * Not a secret. Must be allow-listed by Mojang (https://aka.ms/mce-reviewappid)
 * before api.minecraftservices.com accepts it.
 */
export const MS_CLIENT_ID = 'c59d3724-2960-47b2-8d24-95130e9063e9'

export const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
export const MS_SCOPE = 'XboxLive.signin offline_access'

/** Mojang runtime index (Java 21 = "java-runtime-delta"). */
export const MOJANG_JAVA_RUNTIME_INDEX =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
export const JAVA_RUNTIME_COMPONENT = 'java-runtime-delta'

/** Hosts the downloader is allowed to fetch from (https only). */
export const ALLOWED_DOWNLOAD_HOSTS = [
  'piston-meta.mojang.com',
  'piston-data.mojang.com',
  'launchermeta.mojang.com',
  'libraries.minecraft.net',
  'resources.download.minecraft.net',
  'maven.neoforged.net',
  'cdn.modrinth.com',
  'maven.ftb.dev',
  // CurseForge CDN: the file links of mods that exist only there (Productive Metalworks since pack 0.11.0); the
  // metafile carries the sha256, so a swapped file is refused like any other.
  'mediafilez.forgecdn.net',
  'edge.forgecdn.net',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'underfr.github.io',
  // Player skins: the profile reply's skins[].url, whose last path segment is the file's sha256.
  'textures.minecraft.net',
]

export const INSTANCE_ID = 'consortium'
