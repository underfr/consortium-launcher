// Microsoft account sign-in for the launcher.
//
// Flow: OAuth 2.0 authorization code + PKCE (S256) in the player's system browser, with the
// redirect caught by a one-shot loopback HTTP server, then the Xbox Live -> XSTS -> Minecraft
// services chain through @xmcl/user. Pure Node: the browser opener, the token store and the
// fetch implementation are injected so the Electron layer and the smoke test can supply their own.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  MicrosoftAuthenticator,
  MicrosoftMinecraftXboxLoginError,
  MojangClient,
  ProfileNotFoundError,
  type MinecraftAuthResponse,
  type MojangClientOptions,
  type XBoxResponse,
} from '@xmcl/user'
import { version as LAUNCHER_VERSION } from '../../../package.json'
import { MS_AUTHORITY, MS_SCOPE } from './config'

// ---------------------------------------------------------------------------------------------
// Public types (see docs/CORE_CONTRACT.md, section auth.ts)
// ---------------------------------------------------------------------------------------------

export interface StoredTokens {
  refreshToken: string
  /** Client id the refresh token was issued to; a token from another registration is useless. */
  msClientId: string
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>
  save(t: StoredTokens): Promise<void>
  clear(): Promise<void>
}

export interface Session {
  /** Minecraft profile: UUID without dashes and the player name. */
  profile: { id: string; name: string }
  /** Minecraft services access token, valid for about 24 hours. */
  accessToken: string
  /** Unix time in milliseconds after which accessToken must be refreshed. */
  expiresAt: number
  /** Xbox user id when the XSTS response carried it (passed to the game as --xuid). */
  xuid?: string
}

export interface AuthOptions {
  clientId: string
  store: TokenStore
  /** Opens the sign-in page in the system browser. */
  openExternal: (url: string) => Promise<void>
  log?: (line: string) => void
  /** Every network call goes through this (defaults to the global fetch). */
  fetch?: typeof fetch
}

export type AuthErrorCode =
  | 'not-approved'
  | 'no-xbox-profile'
  | 'child-account'
  | 'no-java-profile'
  | 'not-owned'
  | 'cancelled'
  | 'network'
  | 'unknown'

/** Every failure of this module is an AuthError whose message a player can read as-is. */
export class AuthError extends Error {
  code: AuthErrorCode

  constructor(message: string, code: AuthErrorCode, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const USER_AGENT = `consortium-launcher/${LAUNCHER_VERSION}`
/** How long the browser tab may stay open before the sign-in is abandoned. */
const LOOPBACK_TIMEOUT_MS = 5 * 60_000
/** Upper bound for each single HTTP round trip to Microsoft, Xbox and Mojang. */
const REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------------------------
// PKCE and authorize URL (pure helpers, exported for the smoke test)
// ---------------------------------------------------------------------------------------------

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * RFC 7636: the verifier is 43-128 unreserved characters, the challenge is
 * base64url(sha256(verifier)) without padding. A verifier can be passed in for testing.
 */
export function generatePkce(verifier: string = randomVerifier()): Pkce {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) {
    throw new Error('PKCE verifier must be 43-128 characters of A-Z a-z 0-9 - . _ ~')
  }
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

/** 48 random bytes become 64 base64url characters, all inside the unreserved alphabet. */
function randomVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export interface AuthorizeParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

/** The page the browser is sent to. prompt=select_account lets a family pick the right account. */
export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(`${MS_AUTHORITY}/authorize`)
  url.search = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: MS_SCOPE,
    response_mode: 'query',
    prompt: 'select_account',
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

/**
 * Extracts the authorization code from the redirect request ("/?code=...&state=...").
 * Throws an AuthError for a state mismatch, a cancelled sign-in or a missing code.
 */
export function parseCallback(requestUrl: string, expectedState: string): string {
  const query = new URL(requestUrl, 'http://localhost').searchParams
  // State first: a request that was not triggered by this launcher is ignored whatever it says.
  if (query.get('state') !== expectedState) {
    throw new AuthError(
      'The sign-in reply did not match the request this launcher sent (state mismatch). Click Sign in to try again.',
      'unknown',
    )
  }
  const error = query.get('error')
  if (error) {
    const description = query.get('error_description') ?? ''
    if (error === 'access_denied') {
      throw new AuthError('The Microsoft sign-in was cancelled. Click Sign in to try again.', 'cancelled')
    }
    throw new AuthError(`Microsoft sign-in failed (${error}). ${description}`.trim(), 'unknown')
  }
  const code = query.get('code')
  if (!code) {
    throw new AuthError('The sign-in reply did not include an authorization code. Click Sign in to try again.', 'unknown')
  }
  return code
}

// ---------------------------------------------------------------------------------------------
// Loopback redirect server
// ---------------------------------------------------------------------------------------------

export interface Loopback {
  port: number
  /** Advertised as http://localhost:<port>; Entra ignores the port for localhost redirects. */
  redirectUri: string
  /** Resolves with the authorization code from the first valid GET /, rejects with an AuthError. */
  code: Promise<string>
  /** Resolves once the server has stopped listening (after the callback, the timeout or close()). */
  closed: Promise<void>
  /** Stops the server; safe to call more than once. A pending sign-in is rejected as cancelled. */
  close(): Promise<void>
}

export interface LoopbackOptions {
  timeoutMs?: number
  log?: (line: string) => void
}

/**
 * Listens on 127.0.0.1 with an ephemeral port and accepts exactly one GET on "/". Anything
 * else gets a 404 (400 when the request line cannot be parsed) and does not settle the code
 * promise. The server always closes itself.
 */
export async function startLoopback(expectedState: string, opts: LoopbackOptions = {}): Promise<Loopback> {
  const timeoutMs = opts.timeoutMs ?? LOOPBACK_TIMEOUT_MS
  const log = opts.log ?? console.log

  let settled = false
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (err: AuthError) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // The rejection may happen before anyone awaits the promise (browser failed to open, timeout):
  // mark it handled so Node does not report an unhandled rejection.
  code.catch(() => {})

  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  // A throw inside the 'request' listener is an uncaught exception that takes the whole launcher
  // down, and any local process can talk to this port while it is open: never let handle() throw.
  const server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch (err) {
      log(`auth: loopback request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
      res.end()
    }
  })
  let timer: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined

  const close = (): Promise<void> => {
    if (closing) return closing
    closing = new Promise<void>((resolve) => {
      if (timer) clearTimeout(timer)
      if (!settled) {
        settled = true
        rejectCode(new AuthError('The Microsoft sign-in was cancelled.', 'cancelled'))
      }
      server.close(() => {
        resolveClosed()
        resolve()
      })
      // Browsers keep spare connections open; drop them so close() does not wait for them.
      server.closeAllConnections()
    })
    return closing
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Node accepts absolute-form request targets ("GET http://[ HTTP/1.1"), and an unparsable one
    // makes new URL throw. Answer 400 and keep waiting for the real redirect.
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }).end('Bad request')
      return
    }
    if (req.method !== 'GET' || url.pathname !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }).end('Not found')
      return
    }
    if (settled) {
      res
        .writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
        .end('This sign-in link was already used. Please go back to the launcher.')
      return
    }
    settled = true
    let outcome: { code: string } | { error: AuthError }
    try {
      outcome = { code: parseCallback(url.search, expectedState) }
    } catch (err) {
      outcome = { error: err instanceof AuthError ? err : new AuthError(String(err), 'unknown') }
    }
    const html = 'code' in outcome ? successPage() : errorPage(outcome.error.message)
    res.writeHead('code' in outcome ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
      Connection: 'close',
    })
    // Settle only once the page has been flushed, then tear the server down.
    res.end(html, () => {
      if ('code' in outcome) resolveCode(outcome.code)
      else rejectCode(outcome.error)
      void close()
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', (err) => log(`auth: loopback server error: ${err.message}`))

  const address = server.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new AuthError('Could not open a local port for the Microsoft sign-in. Try again.', 'unknown')
  }

  timer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCode(
      new AuthError('The Microsoft sign-in timed out after 5 minutes. Click Sign in to try again.', 'cancelled'),
    )
    void close()
  }, timeoutMs)

  return {
    port: address.port,
    redirectUri: `http://localhost:${address.port}`,
    code,
    closed,
    close,
  }
}

const DISCLAIMER = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.'

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consortium Launcher - ${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: system-ui, sans-serif; background: #14161a; color: #e8e8e8; text-align: center; }
  main { padding: 2rem; max-width: 32rem; }
  h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
  p { margin: 0.5rem 0; line-height: 1.5; color: #c4c4c4; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 0.75rem; font-size: 0.75rem; color: #777; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
<footer>${DISCLAIMER}</footer>
</body>
</html>
`
}

function successPage(): string {
  return page('Sign-in complete', '<p>You are signed in. You can close this tab and go back to the Consortium Launcher.</p>')
}

function errorPage(message: string): string {
  return page('Sign-in failed', `<p>${escapeHtml(message)}</p><p>You can close this tab and try again from the launcher.</p>`)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------------------------------
// Microsoft token endpoint
// ---------------------------------------------------------------------------------------------

interface MsTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

function isMsTokenResponse(value: unknown): value is MsTokenResponse {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['access_token'] === 'string' &&
    typeof v['expires_in'] === 'number' &&
    (v['refresh_token'] === undefined || typeof v['refresh_token'] === 'string')
  )
}

/** Non-2xx reply from the token endpoint; `error` is the OAuth error code (e.g. invalid_grant). */
class MsTokenRequestError extends AuthError {
  status: number
  error: string

  constructor(status: number, error: string, description: string) {
    super(
      status >= 500
        ? `Microsoft sign-in servers returned an error (HTTP ${status}). Please try again in a moment.`
        : `Microsoft sign-in failed (${error}): ${description}`,
      status >= 500 ? 'network' : 'unknown',
    )
    this.status = status
    this.error = error
  }

  /** True when the refresh token is gone for good and the player must sign in again. */
  get needsInteraction(): boolean {
    return ['invalid_grant', 'interaction_required', 'consent_required', 'login_required'].includes(this.error)
  }
}

async function requestMsToken(fetchImpl: typeof fetch, params: Record<string, string>): Promise<MsTokenResponse> {
  let res: Response
  try {
    res = await fetchImpl(`${MS_AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw networkError(err)
  }
  const text = await res.text()
  const json = tryParseJson(text)
  if (!res.ok) {
    const error = readString(json, 'error') ?? `http_${res.status}`
    const description = readString(json, 'error_description') ?? text
    throw new MsTokenRequestError(res.status, error, description)
  }
  if (!isMsTokenResponse(json)) {
    throw new AuthError('Microsoft sign-in returned an unexpected reply. Please try again.', 'unknown')
  }
  return json
}

function exchangeCode(
  fetchImpl: typeof fetch,
  clientId: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<MsTokenResponse> {
  // Public client: PKCE replaces the client secret.
  return requestMsToken(fetchImpl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
}

function refreshMsToken(fetchImpl: typeof fetch, clientId: string, refreshToken: string): Promise<MsTokenResponse> {
  return requestMsToken(fetchImpl, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: MS_SCOPE,
  })
}

// ---------------------------------------------------------------------------------------------
// Xbox Live and Minecraft services
// ---------------------------------------------------------------------------------------------

/** XSTS 401 XErr codes (from the response body) and what the player can do about them. */
const XSTS_ERRORS: Record<number, { code: AuthErrorCode; message: string }> = {
  2148916227: {
    code: 'unknown',
    message: 'This Xbox account has been banned by Microsoft, so it cannot sign in to Minecraft.',
  },
  2148916229: {
    code: 'child-account',
    message:
      'This account is in a Microsoft family and online play is blocked by its family settings. A parent must allow it at https://account.microsoft.com/family, then try again.',
  },
  2148916233: {
    code: 'no-xbox-profile',
    message:
      'This Microsoft account has no Xbox profile yet. Sign in once at https://www.xbox.com to create one, then try again.',
  },
  2148916234: {
    code: 'no-xbox-profile',
    message:
      'This account has not accepted the Xbox terms of service yet. Sign in once at https://www.xbox.com, then try again.',
  },
  2148916235: {
    code: 'unknown',
    message: 'Xbox Live is not available in the country or region of this Microsoft account.',
  },
  2148916236: {
    code: 'unknown',
    message: 'This account needs adult verification on https://www.xbox.com before it can sign in.',
  },
  2148916237: {
    code: 'unknown',
    message: 'This account needs adult verification on https://www.xbox.com before it can sign in.',
  },
  2148916238: {
    code: 'child-account',
    message:
      'This account belongs to a child. An adult must add it to a Microsoft family at https://account.microsoft.com/family before it can sign in.',
  },
}

function mapXboxError(err: unknown): AuthError {
  if (err instanceof AuthError) return err
  if (isNetworkFailure(err)) return networkError(err)
  const xerr = readNumber(err, 'XErr')
  const known = xerr === undefined ? undefined : XSTS_ERRORS[xerr]
  if (known) return new AuthError(known.message, known.code, { cause: err })
  const detail = err instanceof Error ? err.message : String(err)
  return new AuthError(`Xbox Live sign-in failed. ${detail}`, 'unknown', { cause: err })
}

function mapMinecraftLoginError(err: unknown): AuthError {
  if (err instanceof AuthError) return err
  if (isNetworkFailure(err)) return networkError(err)
  if (err instanceof MicrosoftMinecraftXboxLoginError) {
    const serverMessage = readString(tryParseJson(err.body), 'errorMessage') ?? err.body.trim()
    if (err.status === 403 && /invalid app registration/i.test(err.body)) {
      return new AuthError(
        `Mojang has not approved this launcher's app registration yet, so Minecraft refused the sign-in. Server message: "${serverMessage}". Please tell the server admins.`,
        'not-approved',
        { cause: err },
      )
    }
    if (err.retryable) {
      return new AuthError(
        `Minecraft services are busy right now (HTTP ${err.status}). Please try again in a moment.`,
        'network',
        { cause: err },
      )
    }
    return new AuthError(`Minecraft sign-in failed (HTTP ${err.status}): ${serverMessage}`, 'unknown', { cause: err })
  }
  const detail = err instanceof Error ? err.message : String(err)
  return new AuthError(`Minecraft sign-in failed. ${detail}`, 'unknown', { cause: err })
}

/** The account has no Java profile: tell the player whether it is a missing purchase or a missing name. */
async function missingProfileError(mojang: MojangClient, mcToken: string, log: (line: string) => void): Promise<AuthError> {
  let owned: boolean | undefined
  try {
    const ownership = await mojang.checkGameOwnership(mcToken, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    owned = ownership.items.length > 0
  } catch (err) {
    if (isNetworkFailure(err)) return networkError(err)
    log(`auth: ownership check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (owned === false) {
    return new AuthError(
      'This Microsoft account does not own Minecraft: Java Edition. If you play through Game Pass, open the official Minecraft Launcher once to set up your profile, then sign in here again. Otherwise sign in with the account that owns the game.',
      'not-owned',
    )
  }
  return new AuthError(
    'This account has no Minecraft: Java Edition profile (player name) yet. Open the official Minecraft Launcher once, choose your player name, then come back and sign in again.',
    'no-java-profile',
  )
}

/** Microsoft access token -> Xbox Live -> XSTS -> Minecraft token -> profile. */
async function sessionFromMsToken(fetchImpl: typeof fetch, msAccessToken: string, log: (line: string) => void): Promise<Session> {
  const authenticator = new MicrosoftAuthenticator({ fetch: fetchImpl })

  let minecraftXsts: XBoxResponse
  let liveXsts: XBoxResponse | undefined
  try {
    const result = await authenticator.acquireXBoxToken(msAccessToken, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    minecraftXsts = result.minecraftXstsResponse
    liveXsts = result.liveXstsResponse
  } catch (err) {
    throw mapXboxError(err)
  }
  const claims = minecraftXsts.DisplayClaims.xui[0]
  if (!claims || typeof claims.uhs !== 'string') {
    throw new AuthError('Xbox Live returned an unexpected reply (no user hash). Please try again.', 'unknown')
  }

  let mc: MinecraftAuthResponse
  try {
    mc = await authenticator.loginMinecraftWithXBox(claims.uhs, minecraftXsts.Token, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  } catch (err) {
    throw mapMinecraftLoginError(err)
  }

  const mojang = new MojangClient({ fetch: asMojangFetch(fetchImpl) })
  let profile: { id: string; name: string }
  try {
    profile = await mojang.getProfile(mc.access_token, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  } catch (err) {
    if (err instanceof ProfileNotFoundError) throw await missingProfileError(mojang, mc.access_token, log)
    if (isNetworkFailure(err)) throw networkError(err)
    const detail = err instanceof Error ? err.message : String(err)
    throw new AuthError(`Could not read your Minecraft profile. ${detail}`, 'unknown', { cause: err })
  }

  const session: Session = {
    profile: { id: profile.id, name: profile.name },
    accessToken: mc.access_token,
    expiresAt: Date.now() + mc.expires_in * 1000,
  }
  // The Minecraft relying party usually omits xid; the xboxlive.com one carries it.
  const xuid = nonEmpty(claims.xid) ?? nonEmpty(liveXsts?.DisplayClaims.xui[0]?.xid)
  if (xuid) session.xuid = xuid
  return session
}

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

export async function loginInteractive(o: AuthOptions): Promise<Session> {
  const log = o.log ?? console.log
  const fetchImpl = withUserAgent(o.fetch ?? globalThis.fetch)
  const pkce = generatePkce()
  const state = randomBytes(16).toString('base64url')

  const loopback = await startLoopback(state, { log })
  try {
    const url = buildAuthorizeUrl({
      clientId: o.clientId,
      redirectUri: loopback.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    })
    log(`auth: opening the Microsoft sign-in page, waiting on ${loopback.redirectUri}`)
    try {
      await o.openExternal(url)
    } catch (err) {
      throw new AuthError(
        'Could not open your web browser for the Microsoft sign-in. Open a browser yourself and try again.',
        'unknown',
        { cause: err },
      )
    }
    const code = await loopback.code
    await loopback.close()
    log('auth: authorization code received, exchanging it for tokens')

    const tokens = await exchangeCode(fetchImpl, o.clientId, code, loopback.redirectUri, pkce.verifier)
    const session = await sessionFromMsToken(fetchImpl, tokens.access_token, log)
    // Saved only after the whole chain worked: a failed sign-in leaves nothing behind.
    if (tokens.refresh_token) {
      await o.store.save({ refreshToken: tokens.refresh_token, msClientId: o.clientId })
    } else {
      log('auth: Microsoft returned no refresh token, the player will have to sign in again next time')
    }
    log(`auth: signed in as ${session.profile.name}`)
    return session
  } finally {
    await loopback.close()
  }
}

/** Signs in from the stored refresh token; null when there is none or it is no longer accepted. */
export async function loginSilent(o: AuthOptions): Promise<Session | null> {
  const log = o.log ?? console.log
  const fetchImpl = withUserAgent(o.fetch ?? globalThis.fetch)

  const stored = await o.store.load()
  if (!stored) return null
  if (stored.msClientId !== o.clientId) {
    log('auth: stored refresh token belongs to another app registration, discarding it')
    await o.store.clear()
    return null
  }

  let tokens: MsTokenResponse
  try {
    tokens = await refreshMsToken(fetchImpl, o.clientId, stored.refreshToken)
  } catch (err) {
    if (err instanceof MsTokenRequestError && err.needsInteraction) {
      log(`auth: stored refresh token rejected (${err.error}), the player must sign in again`)
      await o.store.clear()
      return null
    }
    throw err
  }
  // Microsoft rotates refresh tokens on every use: keep the newest one.
  if (tokens.refresh_token) {
    await o.store.save({ refreshToken: tokens.refresh_token, msClientId: o.clientId })
  }

  const session = await sessionFromMsToken(fetchImpl, tokens.access_token, log)
  log(`auth: silent sign-in as ${session.profile.name}`)
  return session
}

export async function logout(o: AuthOptions): Promise<void> {
  await o.store.clear()
  ;(o.log ?? console.log)('auth: signed out, stored refresh token removed')
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Adds the launcher User-Agent to every request, including the ones @xmcl/user makes. */
function withUserAgent(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
    return fetchImpl(input, { ...init, headers })
  }
}

/**
 * MojangClient types its fetch against the undici copy nested under @xmcl/user, whose RequestInit
 * drifted from the undici-types version behind Node's global fetch (dispatcher signature only).
 * At runtime both are the same function, so this is a type-only bridge.
 */
function asMojangFetch(fetchImpl: typeof fetch): NonNullable<MojangClientOptions['fetch']> {
  return fetchImpl as unknown as NonNullable<MojangClientOptions['fetch']>
}

/** undici reports connection problems as TypeError("fetch failed"); timeouts as DOMExceptions. */
function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function networkError(cause: unknown): AuthError {
  return new AuthError(
    'Could not reach the Microsoft or Minecraft sign-in servers. Check your internet connection and try again.',
    'network',
    { cause },
  )
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
