// Smoke test for src/main/core/auth.ts. No Microsoft account needed: the token endpoint, Xbox
// Live and Minecraft services are answered by a stub fetch, and the "browser" performs the
// loopback redirect itself. Only the loopback server is real (127.0.0.1, ephemeral port).
//
//   npx tsx scripts/smoke-auth.ts

import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import {
  AuthError,
  buildAuthorizeUrl,
  generatePkce,
  loginInteractive,
  loginSilent,
  logout,
  parseCallback,
  startLoopback,
  type AuthOptions,
  type Session,
  type StoredTokens,
  type TokenStore,
} from '../src/main/core/auth'
import { MS_AUTHORITY, MS_SCOPE } from '../src/main/core/config'

const CLIENT_ID = '00000000-0000-0000-0000-00000000c0de'
const PROFILE_ID = '069a79f444e94726a5befca90e38aaf5'
const XUID = '2535428504478516'
const log = (line: string): void => console.log('    ' + line)

// ---------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------

class MemoryStore implements TokenStore {
  current: StoredTokens | null
  saved: StoredTokens[] = []
  cleared = 0

  constructor(initial: StoredTokens | null = null) {
    this.current = initial
  }

  async load(): Promise<StoredTokens | null> {
    return this.current
  }

  async save(t: StoredTokens): Promise<void> {
    this.saved.push(t)
    this.current = t
  }

  async clear(): Promise<void> {
    this.cleared += 1
    this.current = null
  }
}

interface StubBehaviour {
  token?: 'ok' | 'invalid_grant'
  xsts?: 'ok' | 'no-xbox-profile'
  loginWithXbox?: 'ok' | 'not-approved'
  profile?: 'ok' | 'not-found'
  entitlements?: 'owned' | 'empty'
  /** What the profile reply lists under skins: an active CLASSIC skin (default), nothing, or an inactive one only. */
  skins?: 'active' | 'none' | 'inactive'
}

/** Legacy 64x32 texture that really exists on the CDN; the path segment is the file's sha256. */
const SKIN_HASH = '292009a4925b58f02c77dadc3ecef07ea4c7472f64e0fdc32ce5522489362680'

interface Stub {
  fetch: typeof fetch
  /** Every URL requested, in order. */
  calls: string[]
  /** Form bodies posted to the token endpoint. */
  tokenBodies: URLSearchParams[]
  userAgents: Set<string>
}

function json(status: number, body: unknown): Response {
  // MojangClient insists on exactly "application/json", like the real api.minecraftservices.com.
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function xboxResponse(claims: Record<string, string>, token: string): unknown {
  return {
    IssueInstant: new Date().toISOString(),
    NotAfter: new Date(Date.now() + 86_400_000).toISOString(),
    Token: token,
    DisplayClaims: { xui: [claims] },
  }
}

/** Realistic replies for every endpoint the sign-in chain touches. */
function makeStub(b: StubBehaviour = {}): Stub {
  const calls: string[] = []
  const tokenBodies: URLSearchParams[] = []
  const userAgents = new Set<string>()

  const stubFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push(url)
    userAgents.add(headers.get('user-agent') ?? '')

    if (url === `${MS_AUTHORITY}/token`) {
      assert.equal(method, 'POST')
      assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded')
      const body = new URLSearchParams(String(init?.body))
      tokenBodies.push(body)
      if (b.token === 'invalid_grant') {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'AADSTS70000: The provided grant is invalid or has expired.',
        })
      }
      const refreshing = body.get('grant_type') === 'refresh_token'
      return json(200, {
        token_type: 'Bearer',
        scope: MS_SCOPE,
        expires_in: 3600,
        ext_expires_in: 3600,
        access_token: 'ms-access-token',
        refresh_token: refreshing ? 'ms-refresh-token-2' : 'ms-refresh-token-1',
      })
    }
    if (url === 'https://user.auth.xboxlive.com/user/authenticate') {
      const body = JSON.parse(String(init?.body)) as { Properties: { RpsTicket: string } }
      assert.equal(body.Properties.RpsTicket, 'd=ms-access-token')
      return json(200, xboxResponse({ uhs: 'uhs-1234' }, 'xbl-user-token'))
    }
    if (url === 'https://device.auth.xboxlive.com/device/authenticate') {
      // @xmcl/user 4.4.2 always fetches a device token before XSTS.
      assert.ok(headers.get('signature'), 'device authenticate must be signed')
      return json(200, {
        IssueInstant: new Date().toISOString(),
        NotAfter: new Date(Date.now() + 86_400_000).toISOString(),
        Token: 'xbl-device-token',
        DisplayClaims: { xdi: { did: 'F50CDD8781FF4476', dcs: '0' } },
      })
    }
    if (url === 'https://xsts.auth.xboxlive.com/xsts/authorize') {
      const body = JSON.parse(String(init?.body)) as { RelyingParty: string; Properties: { UserTokens: string[] } }
      assert.deepEqual(body.Properties.UserTokens, ['xbl-user-token'])
      if (b.xsts === 'no-xbox-profile') {
        return json(401, {
          Identity: '0',
          XErr: 2148916233,
          Message: '',
          Redirect: 'https://start.ui.xboxlive.com/CreateAccount',
        })
      }
      if (body.RelyingParty === 'rp://api.minecraftservices.com/') {
        return json(200, xboxResponse({ uhs: 'uhs-1234' }, 'xsts-minecraft-token'))
      }
      return json(200, xboxResponse({ gtg: 'ConsortiumPlayer', xid: XUID, uhs: 'uhs-1234' }, 'xsts-live-token'))
    }
    if (url === 'https://api.minecraftservices.com/authentication/login_with_xbox') {
      const body = JSON.parse(String(init?.body)) as { identityToken: string }
      assert.equal(body.identityToken, 'XBL3.0 x=uhs-1234;xsts-minecraft-token')
      if (b.loginWithXbox === 'not-approved') {
        return json(403, {
          path: '/authentication/login_with_xbox',
          errorType: 'FORBIDDEN',
          error: 'FORBIDDEN',
          errorMessage: 'Invalid app registration. See https://aka.ms/AppRegInfo for more information',
          developerMessage: 'Invalid app registration. See https://aka.ms/AppRegInfo for more information',
        })
      }
      return json(200, {
        username: PROFILE_ID,
        roles: [],
        access_token: 'mc-access-token',
        token_type: 'Bearer',
        expires_in: 86400,
      })
    }
    if (url === 'https://api.minecraftservices.com/minecraft/profile') {
      assert.equal(headers.get('authorization'), 'Bearer mc-access-token')
      if (b.profile === 'not-found') {
        return json(404, {
          path: '/minecraft/profile',
          errorType: 'NOT_FOUND',
          error: 'NOT_FOUND',
          errorMessage: 'The server has not found anything matching the request URI',
          developerMessage: 'The server has not found anything matching the request URI',
        })
      }
      // The real reply carries plain http URLs; auth.ts upgrades the scheme before the downloader sees it.
      const skins =
        b.skins === 'none'
          ? []
          : [
              {
                id: '6a6e65e0-dcaa-4f5d-ab2b-3e2d3b7a2e6b',
                state: b.skins === 'inactive' ? 'INACTIVE' : 'ACTIVE',
                url: `http://textures.minecraft.net/texture/${SKIN_HASH}`,
                variant: 'CLASSIC',
                alias: 'STEVE',
              },
            ]
      return json(200, { id: PROFILE_ID, name: 'Notch', skins, capes: [] })
    }
    if (url === 'https://api.minecraftservices.com/entitlements/mcstore') {
      assert.equal(headers.get('authorization'), 'Bearer mc-access-token')
      if (b.entitlements === 'empty') return json(200, { items: [], signature: 'jwt-sig', keyId: '1' })
      return json(200, {
        items: [
          { name: 'product_minecraft', signature: 'jwt-sig' },
          { name: 'game_minecraft', signature: 'jwt-sig' },
        ],
        signature: 'jwt-sig',
        keyId: '1',
      })
    }
    throw new Error(`stub fetch: unexpected request ${method} ${url}`)
  }

  return { fetch: stubFetch, calls, tokenBodies, userAgents }
}

interface CapturedAuthorize {
  state?: string
  codeChallenge?: string
  redirectUri?: string
}

/** Stands in for the system browser: checks the authorize URL, then hits the loopback itself. */
function fakeBrowser(captured: CapturedAuthorize): (url: string) => Promise<void> {
  return async (url) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin + parsed.pathname, `${MS_AUTHORITY}/authorize`)
    const q = parsed.searchParams
    assert.equal(q.get('client_id'), CLIENT_ID)
    assert.equal(q.get('response_type'), 'code')
    assert.equal(q.get('scope'), MS_SCOPE)
    assert.equal(q.get('response_mode'), 'query')
    assert.equal(q.get('prompt'), 'select_account')
    assert.equal(q.get('code_challenge_method'), 'S256')
    const state = q.get('state')
    const codeChallenge = q.get('code_challenge')
    const redirectUri = q.get('redirect_uri')
    assert.ok(state && codeChallenge && redirectUri, 'authorize URL must carry state, challenge and redirect')
    captured.state = state
    captured.codeChallenge = codeChallenge
    captured.redirectUri = redirectUri
    const redirect = new URL(redirectUri)
    assert.equal(redirect.hostname, 'localhost')
    assert.equal(redirect.pathname, '/')
    const res = await httpGet(`http://127.0.0.1:${redirect.port}/?code=fake-auth-code&state=${encodeURIComponent(state)}`)
    assert.equal(res.status, 200)
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/** Writes raw bytes to the loopback port (things node:http would refuse to send) and returns the reply. */
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = netConnect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}

/** True when the promise has neither resolved nor rejected after a short grace period. */
async function isPending(p: Promise<unknown>, graceMs = 200): Promise<boolean> {
  const settled = Symbol('settled')
  const outcome = await Promise.race([
    p.then(
      () => settled,
      () => settled,
    ),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), graceMs)),
  ])
  return outcome !== settled
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : undefined
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

async function expectAuthError(p: Promise<unknown>, code: AuthError['code'], contains?: string): Promise<AuthError> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof AuthError, `expected an AuthError, got ${String(caught)}`)
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`)
  if (contains) assert.ok(caught.message.includes(contains), `message should mention "${contains}": ${caught.message}`)
  return caught
}

function options(stub: Stub, store: TokenStore, openExternal: AuthOptions['openExternal']): AuthOptions {
  return { clientId: CLIENT_ID, store, openExternal, log, fetch: stub.fetch }
}

const noBrowser = async (): Promise<void> => {
  throw new Error('the browser must not be opened in this scenario')
}

function assertSession(session: Session): void {
  assert.equal(session.profile.id, PROFILE_ID)
  assert.equal(session.profile.name, 'Notch')
  assert.equal(session.accessToken, 'mc-access-token')
  assert.equal(session.xuid, XUID)
  const remaining = session.expiresAt - Date.now()
  assert.ok(remaining > 86_400_000 - 10_000 && remaining <= 86_400_000, `expiresAt should be about 24 h away, got ${remaining} ms`)
  // The active skin rides on the profile reply: https URL, model from the variant, sha256 from the path.
  assert.deepEqual(session.skin, { url: `https://textures.minecraft.net/texture/${SKIN_HASH}`, model: 'wide', hash: SKIN_HASH })
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function step1Pkce(): void {
  console.log('1. PKCE and pure helpers')
  const pkce = generatePkce()
  assert.match(pkce.verifier, /^[A-Za-z0-9\-._~]{43,128}$/)
  assert.match(pkce.challenge, /^[A-Za-z0-9\-_]{43}$/)
  assert.notEqual(generatePkce().verifier, pkce.verifier, 'verifiers must be random')

  // RFC 7636 appendix B.
  const vector = generatePkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  assert.equal(vector.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  assert.throws(() => generatePkce('too-short'))
  assert.throws(() => generatePkce('x'.repeat(129)))
  log(`verifier ${pkce.verifier.length} chars, RFC 7636 vector matches`)

  const url = new URL(
    buildAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: 'http://localhost:4321', state: 'st', codeChallenge: 'ch' }),
  )
  assert.equal(url.origin + url.pathname, `${MS_AUTHORITY}/authorize`)
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4321')
  assert.equal(url.searchParams.get('scope'), MS_SCOPE)
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.equal(url.searchParams.get('code_challenge'), 'ch')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'st')
  assert.equal(url.searchParams.get('response_mode'), 'query')
  assert.equal(url.searchParams.has('client_secret'), false)

  assert.equal(parseCallback('/?code=abc&state=st', 'st'), 'abc')
  assert.throws(() => parseCallback('/?code=abc&state=other', 'st'), (e: unknown) => e instanceof AuthError)
  assert.throws(() => parseCallback('/?state=st', 'st'), (e: unknown) => e instanceof AuthError)
  assert.throws(
    () => parseCallback('/?error=access_denied&error_description=User+cancelled&state=st', 'st'),
    (e: unknown) => e instanceof AuthError && e.code === 'cancelled',
  )
  assert.throws(
    () => parseCallback('/?error=server_error&error_description=Oops&state=st', 'st'),
    (e: unknown) => e instanceof AuthError && e.code === 'unknown' && e.message.includes('Oops'),
  )
  log('authorize URL and callback parsing ok')
}

async function step2Loopback(): Promise<void> {
  console.log('2. Loopback server')

  // Happy path: an unrelated request first (browsers ask for /favicon.ico), then the redirect.
  const good = await startLoopback('state-ok', { timeoutMs: 10_000, log })
  assert.equal(good.redirectUri, `http://localhost:${good.port}`)
  const favicon = await httpGet(`http://127.0.0.1:${good.port}/favicon.ico`)
  assert.equal(favicon.status, 404)
  const res = await httpGet(`http://127.0.0.1:${good.port}/?code=abc123&state=state-ok`)
  assert.equal(res.status, 200)
  assert.ok(res.body.includes('close this tab'), 'page must tell the player to close the tab')
  assert.ok(res.body.includes('NOT AN OFFICIAL MINECRAFT PRODUCT'), 'page must carry the disclaimer')
  assert.equal(await good.code, 'abc123')
  await withTimeout(good.closed, 3000, 'loopback auto-close')
  await assert.rejects(httpGet(`http://127.0.0.1:${good.port}/`), (e: unknown) => errorCode(e) === 'ECONNREFUSED')
  await good.close() // idempotent
  log(`port ${good.port}: code received, server closed`)

  // A request line node:http cannot turn into a URL must not crash the process (it used to be an
  // uncaught TypeError inside the 'request' listener) and must not settle the sign-in.
  const crashes: unknown[] = []
  const onUncaught = (err: unknown): void => {
    crashes.push(err)
  }
  process.on('uncaughtException', onUncaught)
  const robust = await startLoopback('state-ok', { timeoutMs: 10_000, log })
  try {
    const reply = await withTimeout(
      rawRequest(robust.port, 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
      3000,
      'reply to the malformed request',
    )
    assert.match(reply, /^HTTP\/1\.1 400 /, `malformed request line should get a 400, got: ${reply.slice(0, 40)}`)
    assert.deepEqual(crashes, [], 'the malformed request must not raise an uncaught exception')
    assert.equal(await isPending(robust.code), true, 'the code promise must still be pending after a bad request')
    // The server is still up and a real redirect still goes through.
    const after = await httpGet(`http://127.0.0.1:${robust.port}/?code=still-alive&state=state-ok`)
    assert.equal(after.status, 200)
    assert.equal(await robust.code, 'still-alive')
    await withTimeout(robust.closed, 3000, 'loopback auto-close after bad request')
  } finally {
    process.off('uncaughtException', onUncaught)
    await robust.close()
  }
  log('malformed request line answered with 400, server survived, sign-in still pending')

  // Mismatched state is rejected and the browser sees an error page.
  const bad = await startLoopback('state-ok', { timeoutMs: 10_000, log })
  const badRes = await httpGet(`http://127.0.0.1:${bad.port}/?code=abc123&state=state-wrong`)
  assert.equal(badRes.status, 400)
  assert.ok(badRes.body.includes('Sign-in failed'))
  await expectAuthError(bad.code, 'unknown', 'state mismatch')
  await withTimeout(bad.closed, 3000, 'loopback auto-close after mismatch')
  log('mismatched state rejected')

  // The player pressed Cancel on the Microsoft page.
  const denied = await startLoopback('s', { timeoutMs: 10_000, log })
  await httpGet(`http://127.0.0.1:${denied.port}/?error=access_denied&error_description=The+user+has+denied+access&state=s`)
  await expectAuthError(denied.code, 'cancelled')
  await withTimeout(denied.closed, 3000, 'loopback auto-close after cancel')
  log('access_denied mapped to cancelled')

  // Nobody comes back: timeout.
  const slow = await startLoopback('s', { timeoutMs: 100, log })
  await expectAuthError(withTimeout(slow.code, 3000, 'loopback timeout'), 'cancelled', 'timed out')
  await withTimeout(slow.closed, 3000, 'loopback auto-close after timeout')
  log('timeout mapped to cancelled')
}

async function step3Interactive(): Promise<void> {
  console.log('3. loginInteractive with stubbed Microsoft, Xbox and Minecraft endpoints')
  const stub = makeStub()
  const store = new MemoryStore()
  const captured: CapturedAuthorize = {}
  const session = await loginInteractive(options(stub, store, fakeBrowser(captured)))
  assertSession(session)

  // Token exchange: authorization code + PKCE verifier, no client secret.
  assert.equal(stub.tokenBodies.length, 1)
  const body = stub.tokenBodies[0]
  assert.ok(body)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('client_id'), CLIENT_ID)
  assert.equal(body.get('code'), 'fake-auth-code')
  assert.equal(body.get('redirect_uri'), captured.redirectUri)
  assert.equal(body.has('client_secret'), false)
  const verifier = body.get('code_verifier')
  assert.ok(verifier, 'code_verifier must be sent')
  assert.equal(generatePkce(verifier).challenge, captured.codeChallenge, 'verifier must match the challenge sent to the browser')

  assert.deepEqual(store.saved, [{ refreshToken: 'ms-refresh-token-1', msClientId: CLIENT_ID }])
  for (const ua of stub.userAgents) assert.match(ua, /^consortium-launcher\/\d/)
  for (const endpoint of [
    'https://user.auth.xboxlive.com/user/authenticate',
    'https://xsts.auth.xboxlive.com/xsts/authorize',
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    'https://api.minecraftservices.com/minecraft/profile',
  ]) {
    assert.ok(stub.calls.includes(endpoint), `expected a call to ${endpoint}`)
  }
  log(`session for ${session.profile.name} (${session.profile.id}), xuid ${session.xuid ?? 'none'}, ${stub.calls.length} requests`)
  assert.ok(!stub.calls.some((url) => url.includes('textures.minecraft.net')), 'sign-in itself never fetches the skin texture')

  // An account without a skin, or with only inactive ones, signs in the same and carries no SkinRef.
  const skinless = await loginInteractive(options(makeStub({ skins: 'none' }), new MemoryStore(), fakeBrowser({})))
  assert.equal(skinless.profile.name, 'Notch')
  assert.equal(skinless.skin, undefined)
  const inactive = await loginInteractive(options(makeStub({ skins: 'inactive' }), new MemoryStore(), fakeBrowser({})))
  assert.equal(inactive.skin, undefined)
  log('skins: [] and an INACTIVE-only list both give a session without a skin')
}

async function step4NotApproved(): Promise<void> {
  console.log('4. HTTP 403 "Invalid app registration" from login_with_xbox')
  const stub = makeStub({ loginWithXbox: 'not-approved' })
  const store = new MemoryStore()
  const err = await expectAuthError(
    loginInteractive(options(stub, store, fakeBrowser({}))),
    'not-approved',
    'Invalid app registration. See https://aka.ms/AppRegInfo for more information',
  )
  assert.equal(store.saved.length, 0, 'a failed sign-in must not store a refresh token')
  log(`mapped to ${err.code}: ${err.message}`)
}

async function step5OtherErrors(): Promise<void> {
  console.log('5. Other account states')

  const noProfile = await expectAuthError(
    loginInteractive(options(makeStub({ profile: 'not-found', entitlements: 'owned' }), new MemoryStore(), fakeBrowser({}))),
    'no-java-profile',
  )
  log(`owned but no profile: ${noProfile.message}`)

  const notOwned = await expectAuthError(
    loginInteractive(options(makeStub({ profile: 'not-found', entitlements: 'empty' }), new MemoryStore(), fakeBrowser({}))),
    'not-owned',
  )
  log(`not owned: ${notOwned.message}`)

  const noXbox = await expectAuthError(
    loginInteractive(options(makeStub({ xsts: 'no-xbox-profile' }), new MemoryStore(), fakeBrowser({}))),
    'no-xbox-profile',
  )
  log(`XErr 2148916233: ${noXbox.message}`)

  const stubNetwork = makeStub()
  const offline: typeof fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const network = await expectAuthError(
    loginInteractive({ ...options(stubNetwork, new MemoryStore(), fakeBrowser({})), fetch: offline }),
    'network',
  )
  log(`offline: ${network.message}`)

  const browserFail = await expectAuthError(
    loginInteractive(options(makeStub(), new MemoryStore(), noBrowser)),
    'unknown',
    'browser',
  )
  log(`browser could not open: ${browserFail.message}`)
}

async function step6Silent(): Promise<void> {
  console.log('6. loginSilent and logout')

  const empty = new MemoryStore()
  const emptyStub = makeStub()
  assert.equal(await loginSilent(options(emptyStub, empty, noBrowser)), null)
  assert.equal(emptyStub.calls.length, 0, 'no network call without a stored token')
  log('no stored token: null without any request')

  const foreign = new MemoryStore({ refreshToken: 'someone-elses', msClientId: 'other-client-id' })
  assert.equal(await loginSilent(options(makeStub(), foreign, noBrowser)), null)
  assert.equal(foreign.cleared, 1)
  log('token from another client id: discarded')

  const stub = makeStub()
  const store = new MemoryStore({ refreshToken: 'ms-refresh-token-1', msClientId: CLIENT_ID })
  const session = await loginSilent(options(stub, store, noBrowser))
  assert.ok(session, 'silent sign-in should return a session')
  assertSession(session)
  const body = stub.tokenBodies[0]
  assert.ok(body)
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'ms-refresh-token-1')
  assert.equal(body.get('client_id'), CLIENT_ID)
  assert.equal(body.get('scope'), MS_SCOPE)
  assert.equal(body.has('client_secret'), false)
  assert.deepEqual(store.current, { refreshToken: 'ms-refresh-token-2', msClientId: CLIENT_ID }, 'rotated refresh token must be stored')
  log(`refreshed session for ${session.profile.name}, rotated refresh token stored`)

  const expired = new MemoryStore({ refreshToken: 'ms-refresh-token-old', msClientId: CLIENT_ID })
  assert.equal(await loginSilent(options(makeStub({ token: 'invalid_grant' }), expired, noBrowser)), null)
  assert.equal(expired.current, null, 'a rejected refresh token must be cleared')
  log('invalid_grant: null and store cleared')

  const out = new MemoryStore({ refreshToken: 'ms-refresh-token-2', msClientId: CLIENT_ID })
  await logout(options(makeStub(), out, noBrowser))
  assert.equal(out.current, null)
  log('logout cleared the store')
}

async function main(): Promise<void> {
  step1Pkce()
  await step2Loopback()
  await step3Interactive()
  await step4NotApproved()
  await step5OtherErrors()
  await step6Silent()
  console.log('OK: auth helpers')
}

main().catch((err: unknown) => {
  console.error('FAILED:', err)
  process.exit(1)
})
