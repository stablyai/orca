import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../src/main/browser/browser-local-https-test-certificate'
import { test as base, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { waitForSessionReady } from './helpers/store'

// Why: these hosts resolve nowhere, so the relay reaches them only through the proxy below.
const CLOUD_HOST = 'cloud.relay-e2e.test'
const DIRECTOR_HOST = 'director.relay-e2e.test'
const CELL_HOST = 'cell.relay-e2e.test'

type Lab = {
  proxyUrl: string
  pacUrl: string
  tunnels: string[]
  backendRequests: string[]
  close: () => Promise<void>
}

type Listening = { port: number; close: () => Promise<void> }

// Why: tunnels are upgraded sockets that server.close() would wait on forever.
async function listen(server: HttpServer | HttpsServer): Promise<Listening> {
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    close: () => {
      sockets.forEach((socket) => socket.destroy())
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

// A fake Orca Cloud + relay director behind a recording HTTP CONNECT proxy.
async function startLab(): Promise<Lab> {
  const tunnels: string[] = []
  const backendRequests: string[] = []
  const backend = createHttpsServer(
    { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE },
    (request, response) => {
      backendRequests.push(`${request.method} ${request.headers.host}${request.url}`)
      const json = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (request.url === '/v1/desktop/auth/relay-token') {
        json(200, { relayToken: 'e2e-relay-token', expiresAt: Date.now() + 300_000 })
      } else if (request.url === '/v1/assign') {
        json(200, {
          v: 1,
          cellUrl: `https://${CELL_HOST}`,
          assignmentEpoch: 1,
          lease: 'e2e-lease'
        })
      } else {
        json(404, { error: 'not_found' })
      }
    }
  )
  const listeningBackend = await listen(backend)

  let proxyAuthority = ''
  // Chromium fetches the PAC file directly; it sends only the relay hosts to the proxy.
  const proxy = createHttpServer((request, response) => {
    if (request.url !== '/proxy.pac') {
      response.writeHead(502).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' })
    response.end(
      `function FindProxyForURL(url, host) { return dnsDomainIs(host, '.relay-e2e.test') ? 'PROXY ${proxyAuthority}' : 'DIRECT' }`
    )
  })
  proxy.on('connect', (request, client, head) => {
    const authority = request.url ?? ''
    tunnels.push(authority)
    const host = authority.split(':')[0]
    // The cell socket only needs to reach the proxy to prove its route.
    if (host === CELL_HOST || !host?.endsWith('.relay-e2e.test')) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const upstream = netConnect(listeningBackend.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client).pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  const listeningProxy = await listen(proxy)
  proxyAuthority = `127.0.0.1:${listeningProxy.port}`

  return {
    proxyUrl: `http://${proxyAuthority}`,
    pacUrl: `http://${proxyAuthority}/proxy.pac`,
    tunnels,
    backendRequests,
    close: async () => {
      await listeningProxy.close()
      await listeningBackend.close()
    }
  }
}

// Why a fixture: the lab must listen before the app launches so a PAC URL can name it.
const test = base.extend<{ lab: Lab; usePacFile: boolean }>({
  usePacFile: [false, { option: true }],
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  lab: async ({}, provide) => {
    const lab = await startLab()
    await provide(lab)
    await lab.close()
  },
  orcaAppExtraArgs: async ({ lab, usePacFile }, provide) => {
    // Chromium (net.fetch) must accept the fake backend's localhost certificate.
    await provide([
      '--ignore-certificate-errors',
      ...(usePacFile ? [`--proxy-pac-url=${lab.pacUrl}`] : [])
    ])
  }
})

test.use({
  orcaAppExtraEnv: {
    ORCA_CLOUD_API_URL: `https://${CLOUD_HOST}`,
    ORCA_CLOUD_CLIENT_ID: 'relay-proxy-e2e',
    ORCA_RELAY_URL: `https://${DIRECTOR_HOST}`,
    ORCA_CLOUD_DEV_AUTH: '1',
    ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION: '1'
  }
})

async function signInAndEnable(page: Page, proxyUrl: string): Promise<void> {
  await waitForSessionReady(page)
  // Off by default: absent means direct.
  expect(
    await page.evaluate(async () => (await window.api.settings.get()).relayAndCloudUseProxy)
  ).not.toBe(true)
  await page.evaluate(async (httpProxyUrl) => {
    await window.api.settings.set({ httpProxyUrl, relayAndCloudUseProxy: true })
    await window.api.orcaProfiles.connectCurrent()
  }, proxyUrl)
}

function requestPairing(page: Page): Promise<unknown> {
  return page.evaluate(() =>
    window.api.mobile.getPairingQR({ connectionMode: 'automatic' }).catch(() => null)
  )
}

// On: token exchange, assignment, and the control websocket all tunnel through the proxy.
async function expectRelayTrafficProxied(page: Page, lab: Lab): Promise<void> {
  void requestPairing(page)
  await expect
    .poll(() => lab.tunnels, { timeout: 30_000 })
    .toEqual(
      expect.arrayContaining([`${CLOUD_HOST}:443`, `${DIRECTOR_HOST}:443`, `${CELL_HOST}:443`])
    )
  expect(lab.backendRequests).toEqual(
    expect.arrayContaining([
      `POST ${CLOUD_HOST}/v1/desktop/auth/relay-token`,
      `POST ${DIRECTOR_HOST}/v1/assign`
    ])
  )
}

test.describe('Orca Relay and Orca Cloud proxy setting', () => {
  test('routes relay HTTP and the relay websocket through the proxy only while on', async ({
    orcaPage,
    lab
  }) => {
    await signInAndEnable(orcaPage, lab.proxyUrl)
    await expectRelayTrafficProxied(orcaPage, lab)

    // Off: the same relay attempt goes direct, so nothing reaches the proxy or the backend.
    await orcaPage.evaluate(() => window.api.settings.set({ relayAndCloudUseProxy: false }))
    lab.tunnels.length = 0
    lab.backendRequests.length = 0
    const offAttempt = await orcaPage.evaluate(async () => {
      const statuses: string[] = []
      const unsubscribe = window.api.mobile.onRelayStatusChanged((detail) =>
        statuses.push(detail.status)
      )
      const pairing = await window.api.mobile
        .getPairingQR({ connectionMode: 'automatic' })
        .catch(() => null)
      unsubscribe()
      return { pairing, statuses }
    })
    // With the proxy bypassed the backend is unreachable: the user's reported failure.
    expect(offAttempt.pairing).toMatchObject({
      relayFailure: { code: 'relay_control_not_active', stage: 'create_pairing_relay' }
    })
    // Presence precondition: a relay connection attempt really ran after the toggle.
    expect(offAttempt.statuses).toContain('connecting')
    expect(lab.tunnels.filter((authority) => authority.endsWith('.relay-e2e.test:443'))).toEqual([])
    expect(lab.backendRequests).toEqual([])
  })

  test.describe('with a PAC file (the system-proxy resolver)', () => {
    test.use({ usePacFile: true })

    test('follows the PAC answer when Orca has no proxy URL of its own', async ({
      orcaPage,
      lab
    }) => {
      await signInAndEnable(orcaPage, '')
      await expectRelayTrafficProxied(orcaPage, lab)
    })
  })
})
