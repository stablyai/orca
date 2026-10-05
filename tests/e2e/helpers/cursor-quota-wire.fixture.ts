import { app, net, session } from 'electron'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { writeFileSync } from 'node:fs'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../../src/main/browser/browser-local-https-test-certificate'
import { fetchCursorRateLimits } from '../../../src/main/rate-limits/cursor-fetcher'
import {
  cursorSessionCookie,
  parseCursorSessionToken
} from '../../../src/main/rate-limits/cursor-session-token'
import type { CursorAuthReadResult } from '../../../src/main/rate-limits/cursor-auth'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing fixture environment: ${name}`)
  }
  return value
}

app.setPath('userData', requiredEnv('ORCA_E2E_USER_DATA_DIR'))
app.setPath('home', requiredEnv('ORCA_E2E_HOME_DIR'))

function auth(account: string, revision = 'fresh', exp = 4_000_000_000): CursorAuthReadResult {
  const token = parseCursorSessionToken(
    `e30.${Buffer.from(JSON.stringify({ sub: `auth0|fake_${account}`, exp })).toString('base64url')}.${revision}`
  )
  if (!token) {
    throw new Error('Invalid fake fixture token')
  }
  return {
    status: 'ok',
    session: {
      token,
      source: 'cli',
      email: null,
      displayName: null,
      membershipType: null,
      subscriptionStatus: null
    }
  }
}

function cookie(read: CursorAuthReadResult): string {
  if (read.status !== 'ok') {
    throw new Error('Fixture needs an authenticated fake account')
  }
  return cursorSessionCookie(read.session.token)
}

const accountA = auth('A')
const accountB = auth('B')
const oldA = auth('A', 'old')
const summary = (used: number) => ({
  membershipType: 'pro',
  individualUsage: { plan: { enabled: true, used, limit: 100 } }
})
let stage = 'waiting-for-ready'
const resultPath = requiredEnv('ORCA_CURSOR_WIRE_RESULT')
writeFileSync(resultPath, JSON.stringify({ stage }))

async function run(): Promise<void> {
  await app.whenReady()
  stage = 'ready'
  writeFileSync(resultPath, JSON.stringify({ stage }))
  const receipts: { arm: string; path: string; account: string; headerAccount: string }[] = []
  const outcomes: { arm: string; status: string; used?: number; failureKind?: string }[] = []
  let arm = ''
  let scenario = 'summary'
  let targetHits = 0
  const target = createServer((_request, response) => {
    targetHits++
    response.end('unexpected redirect')
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const targetAddress = target.address()
  if (!targetAddress || typeof targetAddress === 'string') {
    throw new Error('No target listener')
  }
  const targetOrigin = `http://127.0.0.1:${targetAddress.port}`
  const respond = (request: IncomingMessage, response: ServerResponse): void => {
    const incoming = request.headers.cookie
    const account =
      incoming === cookie(accountA) ? 'A' : incoming === cookie(accountB) ? 'B' : 'other'
    receipts.push({
      arm,
      path: request.url ?? '',
      account,
      headerAccount: request.headers.authorization ? 'unexpected' : 'none'
    })
    if (scenario === 'redirect302' || scenario === 'redirect307') {
      response.writeHead(scenario === 'redirect302' ? 302 : 307, {
        Location: `${targetOrigin}/sink`
      })
      response.end()
      return
    }
    if (scenario === 'disconnect') {
      request.socket.destroy()
      return
    }
    const status = scenario.startsWith('http')
      ? Number(scenario.slice(4))
      : account === 'other'
        ? 401
        : 200
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Retry-After': '30',
      'Set-Cookie': 'fixture_response=must-not-enter-jar; Path=/'
    })
    if (scenario === 'parse') {
      response.end('invalid JSON')
    } else if (scenario === 'legacy' && request.url === '/api/usage-summary') {
      response.end('{}')
    } else if (scenario === 'legacy') {
      response.end(JSON.stringify({ 'gpt-4': { numRequests: 25, maxRequestUsage: 100 } }))
    } else {
      response.end(JSON.stringify(summary(account === 'A' ? 25 : 75)))
    }
  }
  const http = createServer(respond)
  const https = createHttpsServer(
    { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
    respond
  )
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve))
  const httpAddress = http.address(),
    httpsAddress = https.address()
  if (
    !httpAddress ||
    typeof httpAddress === 'string' ||
    !httpsAddress ||
    typeof httpsAddress === 'string'
  ) {
    throw new Error('No fixture listener')
  }
  const httpOrigin = `http://127.0.0.1:${httpAddress.port}`
  const httpsOrigin = `https://127.0.0.1:${httpsAddress.port}`
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(
      request.hostname === '127.0.0.1' &&
        request.certificate.data.trim() === LOCAL_HTTPS_TEST_CERTIFICATE.trim()
        ? 0
        : -3
    )
  })
  let origin = httpOrigin
  const nativeFetch = net.fetch.bind(net)
  // Route only the provider URL and CSRF origin to loopback; Cookie and credential mode reach native fetch unchanged.
  net.fetch = (url, options) => {
    const parsed = new URL(String(url))
    if (parsed.origin !== 'https://cursor.com') {
      throw new Error('Fixture refuses non-Cursor requests')
    }
    return nativeFetch(origin + parsed.pathname + parsed.search, {
      ...options,
      headers: { ...options?.headers, Origin: origin, Referer: `${origin}/dashboard` }
    })
  }
  const jarUnchanged: boolean[] = []
  const fetch = async (
    name: string,
    requested: CursorAuthReadResult,
    signal?: AbortSignal
  ): Promise<void> => {
    arm = name
    stage = name
    const result = await fetchCursorRateLimits({ authReadResult: requested, signal })
    outcomes.push({
      arm: name,
      status: result.status,
      used: result.monthly?.usedPercent,
      failureKind: result.usageMetadata?.failureKind
    })
  }
  try {
    for (const protocol of ['http', 'https']) {
      origin = protocol === 'http' ? httpOrigin : httpsOrigin
      for (const [name, jar, requested] of [
        ['empty-A', null, accountA],
        ['jar-A-A', accountA, accountA],
        ['jar-A-B', accountA, accountB],
        ['jar-B-A', accountB, accountA],
        ['old-A-fresh-A', oldA, accountA]
      ] as const) {
        await session.defaultSession.clearStorageData()
        if (jar) {
          await session.defaultSession.cookies.set({
            url: origin,
            name: 'WorkosCursorSessionToken',
            value: cookie(jar).slice('WorkosCursorSessionToken='.length),
            httpOnly: true
          })
        }
        const before = await session.defaultSession.cookies.get({ url: origin })
        scenario = 'summary'
        await fetch(`${protocol}-${name}`, requested)
        jarUnchanged.push(
          JSON.stringify(await session.defaultSession.cookies.get({ url: origin })) ===
            JSON.stringify(before)
        )
      }
      await session.defaultSession.clearStorageData()
      scenario = 'summary'
      await Promise.all([
        fetch(`${protocol}-parallel-A`, accountA),
        fetch(`${protocol}-parallel-B`, accountB)
      ])
      for (const mode of [
        'http401',
        'http403',
        'http429',
        'http500',
        'parse',
        'disconnect',
        'redirect302',
        'redirect307',
        'legacy'
      ]) {
        scenario = mode
        await fetch(`${protocol}-${mode}`, accountA)
      }
      scenario = 'summary'
      await fetch(`${protocol}-expired`, auth('A', 'expired', 1))
      await fetch(`${protocol}-aborted`, accountA, AbortSignal.abort())
    }
    writeFileSync(
      resultPath,
      JSON.stringify({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        receipts,
        outcomes,
        jarUnchanged,
        targetHits
      })
    )
  } finally {
    net.fetch = nativeFetch
    http.close()
    https.close()
    target.close()
  }
}

void run().then(
  () => app.exit(0),
  (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    writeFileSync(resultPath, JSON.stringify({ stage, error: detail }))
    app.exit(1)
  }
)
