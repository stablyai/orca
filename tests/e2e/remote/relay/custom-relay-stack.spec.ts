import { request } from 'node:https'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { expect } from '@stablyai/playwright-test'
import { test as base } from '../../desktop/electron-fixtures/orca-app'
import { startCustomRelayStack } from './custom-relay-stack'
import { decodePairingOffer } from '../../../../src/shared/remote-runtime/pairing/pairing'
import { createPairedE2EEClientHandshake } from '../../../../src/shared/remote-runtime/e2ee/paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../src/shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { RelayPhoneHelloSchema } from '../../../../src/shared/remote-runtime/relay/mobile-relay-phone-protocol'

type Stack = Awaited<ReturnType<typeof startCustomRelayStack>>
const test = base.extend<{ stack: Stack; envOverride: boolean }>({
  envOverride: [false, { option: true }],
  // Playwright requires destructured fixture arguments.
  // oxlint-disable-next-line no-empty-pattern
  stack: async ({}, provideFixture) => {
    const stack = await startCustomRelayStack()
    try {
      await provideFixture(stack)
    } finally {
      await stack.close()
    }
  },
  orcaAppExtraEnv: async ({ stack, envOverride }, provideFixture) => {
    await provideFixture({
      NODE_EXTRA_CA_CERTS: stack.certPath,
      ORCA_CLOUD_API_URL: envOverride ? stack.authUrl : '',
      ORCA_CLOUD_CLIENT_ID: envOverride ? 'orca-desktop' : '',
      ORCA_RELAY_URL: envOverride ? stack.relayUrl : ''
    })
  }
})

function http(
  url: string,
  cert: Buffer,
  body?: string
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        ca: cert,
        method: body ? 'POST' : 'GET',
        ...(body
          ? {
              headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(body)
              }
            }
          : {})
      },
      (res) => {
        res.resume()
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location })
        )
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function phone(offerUrl: string, cert: Buffer) {
  const offer = decodePairingOffer(offerUrl)
  if (!offer.relay) {
    throw new Error('Pairing offer omitted relay')
  }
  const relay = offer.relay
  const url = new URL(`/v1/connect/${relay.relayHostId}`, relay.cellUrl)
  url.protocol = 'wss:'
  const ws = new WebSocket(url, { ca: cert })
  const handshake = createPairedE2EEClientHandshake({
    primitives: NODE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64: offer.publicKeyB64,
    framing: 'v2',
    transport: 'relay',
    relayHostId: relay.relayHostId
  })
  let state = 'relay'
  let resolveRpc!: (value: unknown) => void
  let rejectRpc!: (error: Error) => void
  const rpc = new Promise<unknown>((resolve, reject) => {
    resolveRpc = resolve
    rejectRpc = reject
  })
  const closed = new Promise<number>((resolve) => ws.once('close', resolve))
  ws.on('error', rejectRpc)
  ws.on('open', () =>
    ws.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: relay.inviteToken })
    )
  )
  ws.on('message', async (data, binary) => {
    try {
      if (binary) {
        throw new Error('Unexpected binary frame')
      }
      const text = data.toString()
      if (state === 'relay') {
        const hello = RelayPhoneHelloSchema.parse(JSON.parse(text))
        if (!hello.ok || hello.credentialKind !== 'invite') {
          throw new Error('Relay rejected invite')
        }
        state = 'ready'
        ws.send(handshake.helloText())
        return
      }
      if (state === 'ready') {
        if (handshake.acceptReadyText(text) !== 'accepted') {
          throw new Error('E2EE ready rejected')
        }
        state = 'auth'
        ws.send(await handshake.sealAuth({ kind: 'token', deviceToken: offer.deviceToken }))
        return
      }
      const plaintext = handshake.channel.openText(text)
      if (plaintext === null) {
        throw new Error('E2EE frame invalid')
      }
      if (state === 'auth') {
        if (handshake.classifyAuthReply(plaintext).kind !== 'authenticated') {
          throw new Error('E2EE auth rejected')
        }
        state = 'rpc'
        ws.send(
          handshake.channel.sealText(
            JSON.stringify({
              id: 'status',
              method: 'status.get',
              params: {},
              deviceToken: offer.deviceToken
            })
          )
        )
        return
      }
      const response = JSON.parse(plaintext)
      if (response.id === 'status') {
        resolveRpc(response)
      }
    } catch (error) {
      rejectRpc(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return { ws, rpc, closed }
}

test('custom relay authenticates, pairs and retires its session', async ({
  stack,
  electronApp,
  orcaPage
}) => {
  // Relay recovery and two isolated process startups need a longer budget.
  test.setTimeout(240_000)
  await orcaPage.setViewportSize({ width: 1440, height: 1000 })
  await expect
    .poll(
      async () =>
        http(`${stack.authUrl}/healthz`, stack.cert)
          .then((r) => r.status)
          .catch(() => 0),
      { timeout: 30_000 }
    )
    .toBe(200)
  await expect
    .poll(
      async () =>
        http(`${stack.relayUrl}/v1/regions`, stack.cert)
          .then((r) => r.status)
          .catch(() => 0),
      { timeout: 30_000 }
    )
    .toBe(200)
  await electronApp.evaluate(({ shell, session }, certificate) => {
    shell.openExternal = async () => {}
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      callback(
        request.hostname === '127.0.0.1' && request.certificate.data.trim() === certificate.trim()
          ? 0
          : -3
      )
    })
  }, stack.cert.toString())
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'mobile', repoId: null })
    state.openSettingsPage()
  })
  await expect(orcaPage.getByText('Custom relay server', { exact: true })).toBeVisible()
  await orcaPage.getByRole('switch', { name: 'Use custom server' }).click()
  await orcaPage.getByLabel('Auth server URL').fill('https://127.0.0.1:1')
  await orcaPage.getByLabel('Client ID').fill('orca-desktop')
  await orcaPage.getByLabel('Relay director URL').fill(stack.relayUrl)
  await orcaPage.getByRole('button', { name: 'Test connection' }).click()
  await expect(
    orcaPage.getByText('Auth server: no Orca sign-in service found at this URL')
  ).toBeVisible()
  await expect(orcaPage.getByText('Relay director: connected')).toBeVisible()
  await orcaPage.getByLabel('Auth server URL').fill(stack.authUrl)
  await orcaPage.getByRole('button', { name: 'Test connection' }).click()
  await expect(orcaPage.getByText('Auth server: connected')).toBeVisible()
  await expect(orcaPage.getByText('Relay director: connected')).toBeVisible()
  mkdirSync(path.join(process.cwd(), '.cache', 'relay-e2e'), { recursive: true })
  await orcaPage.screenshot({
    path: path.join(process.cwd(), '.cache', 'relay-e2e', 'settings-connected.png')
  })
  await orcaPage.getByRole('button', { name: 'Apply changes' }).click()
  await orcaPage.getByRole('dialog').getByRole('button', { name: 'Switch servers' }).click()
  await expect(orcaPage.getByRole('dialog')).toBeHidden()
  await orcaPage.getByRole('radio', { name: /Orca Relay/ }).click()
  await orcaPage.getByRole('button', { name: 'Sign in for Relay' }).click()
  let link = ''
  await expect
    .poll(
      async () => {
        link = (await orcaPage.evaluate(() => window.api.orcaProfiles.signInProgress()))?.link ?? ''
        return link
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  const response = await http(
    link,
    stack.cert,
    new URLSearchParams({ secret: stack.secret }).toString()
  )
  expect(response.status).toBe(303)
  expect(response.location).toBeTruthy()
  const callback = await fetch(response.location!)
  expect(callback.status).toBe(200)
  await expect
    .poll(async () => (await orcaPage.evaluate(() => window.api.orcaProfiles.authStatus())).state, {
      timeout: 30_000
    })
    .toBe('connected')
  const pairing = await orcaPage.evaluate(() =>
    window.api.mobile.getPairingQR({ address: '127.0.0.1', connectionMode: 'automatic' })
  )
  if (!pairing.available) {
    throw new Error(`Pairing failed: ${JSON.stringify(pairing)}`)
  }
  const simulated = await phone(pairing.pairingUrl, stack.cert)
  try {
    await expect(simulated.rpc).resolves.toMatchObject({ id: 'status', ok: true })
    await expect(orcaPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
    await stack.stopRelay()
    await expect(orcaPage.getByText('Unavailable', { exact: true })).toBeVisible({
      timeout: 60_000
    })
    stack.startRelay()
    await expect(orcaPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 90_000 })
    const nextPairing = await orcaPage.evaluate(() =>
      window.api.mobile.getPairingQR({
        address: '127.0.0.1',
        connectionMode: 'automatic',
        rotate: true
      })
    )
    if (!nextPairing.available) {
      throw new Error(`Pairing after restart failed: ${JSON.stringify(nextPairing)}`)
    }
    const activePhone = await phone(nextPairing.pairingUrl, stack.cert)
    await expect(activePhone.rpc).resolves.toMatchObject({ id: 'status', ok: true })
    await orcaPage.getByLabel('Auth server URL').fill('https://127.0.0.1:1')
    await orcaPage.getByLabel('Relay director URL').fill('https://127.0.0.1:1')
    await orcaPage.getByRole('button', { name: 'Apply changes' }).click()
    await orcaPage.getByRole('dialog').getByRole('button', { name: 'Switch servers' }).click()
    await expect(orcaPage.getByRole('dialog')).toBeHidden()
    await expect
      .poll(async () => (await orcaPage.evaluate(() => window.api.orcaProfiles.authStatus())).state)
      .not.toBe('connected')
    await expect(activePhone.closed).resolves.toBeGreaterThan(0)
    await expect.poll(() => stack.relayObservations.liveControls).toBe(0)
    activePhone.ws.terminate()
  } finally {
    simulated.ws.terminate()
  }
})

test.describe('environment override', () => {
  test.use({ envOverride: true })
  test('saved server changes preserve the environment session', async ({
    stack,
    electronApp,
    orcaPage
  }) => {
    await orcaPage.setViewportSize({ width: 1440, height: 1000 })
    await expect
      .poll(
        async () =>
          http(`${stack.authUrl}/healthz`, stack.cert)
            .then((r) => r.status)
            .catch(() => 0),
        { timeout: 30_000 }
      )
      .toBe(200)
    await electronApp.evaluate(({ shell }) => {
      shell.openExternal = async () => {}
    })
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'mobile', repoId: null })
      state.openSettingsPage()
    })
    await orcaPage.getByRole('radio', { name: /Orca Relay/ }).click()
    await orcaPage.getByRole('button', { name: 'Sign in for Relay' }).click()
    let link = ''
    await expect
      .poll(
        async () => {
          link =
            (await orcaPage.evaluate(() => window.api.orcaProfiles.signInProgress()))?.link ?? ''
          return link
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    const response = await http(
      link,
      stack.cert,
      new URLSearchParams({ secret: stack.secret }).toString()
    )
    expect(response.status).toBe(303)
    expect(response.location).toBeTruthy()
    expect((await fetch(response.location!)).status).toBe(200)
    await expect
      .poll(
        async () => (await orcaPage.evaluate(() => window.api.orcaProfiles.authStatus())).state,
        { timeout: 30_000 }
      )
      .toBe('connected')
    await orcaPage.getByRole('switch', { name: 'Use custom server' }).click()
    await orcaPage.getByLabel('Auth server URL').fill('https://127.0.0.1:1')
    await orcaPage.getByLabel('Client ID').fill('different-client')
    await orcaPage.getByLabel('Relay director URL').fill('https://127.0.0.1:1')
    await expect(
      orcaPage.getByText(
        'Environment variables override saved settings. Test connection checks the URLs entered here.'
      )
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Apply changes' }).click()
    await orcaPage.getByRole('dialog').getByRole('button', { name: 'Switch servers' }).click()
    await expect(orcaPage.getByRole('dialog')).toBeHidden()
    expect((await orcaPage.evaluate(() => window.api.orcaProfiles.authStatus())).state).toBe(
      'connected'
    )
    const relayOption = orcaPage.getByRole('radio', { name: /Orca Relay/ })
    await expect(relayOption).toHaveAttribute('aria-checked', 'true')
    await expect(relayOption).toHaveAttribute('aria-disabled', 'false')
    await expect(orcaPage.getByRole('button', { name: /Sign in/ })).toBeHidden()
    await expect(
      orcaPage.getByRole('button', { name: /^(Generate|Regenerate) QR code$/ })
    ).toBeEnabled()
    const pairing = await orcaPage.evaluate(() =>
      window.api.mobile.getPairingQR({ address: '127.0.0.1', connectionMode: 'automatic' })
    )
    if (!pairing.available) {
      throw new Error(`Environment relay pairing failed: ${JSON.stringify(pairing)}`)
    }
    expect(decodePairingOffer(pairing.pairingUrl).relay?.directorUrl).toBe(stack.relayUrl)
    await expect(orcaPage.getByText('Ready', { exact: true })).toBeVisible({ timeout: 30_000 })
  })
})
