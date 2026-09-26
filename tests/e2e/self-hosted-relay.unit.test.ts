import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { loadRelayConfig } from '../../cloud/apps/relay/src/config'
import { openInMemoryRelayDatabase } from '../../cloud/apps/relay/src/database'
import { createRelayServer } from '../../cloud/apps/relay/src/relay-server'
import { DeviceRegistry } from '../../src/main/runtime/device-registry'
import {
  MobileSocketWiring,
  type AuthenticatedMobileSocket
} from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { RelaySessionBroker } from '../../src/main/runtime/relay/relay-session-broker'
import {
  getSelfHostedRelayConfig,
  selfHostedRelayAuthContext
} from '../../src/main/runtime/relay/self-hosted-relay-config'
import { SimulatedMobileE2EEV2Peer } from '../../src/main/runtime/relay/simulated-mobile-e2ee-v2-peer'
import { PairingOfferSchema } from '../../src/shared/mobile-relay-pairing-offer'

async function nextText(socket: WebSocket): Promise<string> {
  const [raw] = await once(socket, 'message')
  if (!Buffer.isBuffer(raw)) {
    throw new Error('expected WebSocket message bytes')
  }
  return raw.toString()
}

it('pairs, exchanges encrypted RPC, resumes and revokes through a self-hosted relay', async () => {
  const origin = 'https://relay.example.test'
  const accessKey = 'owner-access-key-with-at-least-32-characters'
  const config = loadRelayConfig({
    ORCA_RELAY_PUBLIC_URL: origin,
    ORCA_RELAY_CELL_URL: origin,
    ORCA_RELAY_SELF_HOSTED_KEY: accessKey,
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'server-signing-key-with-at-least-32-characters'
  })
  const database = await openInMemoryRelayDatabase()
  const relay = createRelayServer(config, database)
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-self-hosted-test-'))
  const sockets = new Set<WebSocket>()
  let broker: RelaySessionBroker | undefined
  try {
    await relay.assignments.reconcileCells(config.cells)
    relay.server.listen(0, '127.0.0.1')
    await once(relay.server, 'listening')
    const address = relay.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('missing relay test port')
    }
    const localOrigin = `http://127.0.0.1:${address.port}`
    const fetchRelay: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      )
      expect(url.origin).toBe(origin)
      return await fetch(`${localOrigin}${url.pathname}`, init)
    }
    const connectSocket = (url: string, headers?: Record<string, string>) => {
      const parsed = new URL(url)
      expect(parsed.protocol).toBe('wss:')
      expect(parsed.host).toBe(new URL(origin).host)
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}${parsed.pathname}`, { headers })
      sockets.add(socket)
      return socket
    }
    expect(await relay.ready()).toBe(true)
    const keys = nacl.box.keyPair()
    const keypair = { ...keys, publicKeyB64: Buffer.from(keys.publicKey).toString('base64') }
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.addDevice('Phone', 'mobile')
    registry.setMobilePairingConnectionMode(device.deviceId, 'automatic', 'self-hosted')
    let authenticatedSocket: AuthenticatedMobileSocket | undefined
    const wiring = new MobileSocketWiring({
      deviceRegistry: registry,
      e2eeKeypair: keypair,
      onText: (socket, plaintext, reply) => {
        authenticatedSocket = socket
        reply(JSON.stringify({ ok: true, echo: plaintext }))
      },
      onBinary: () => {},
      onClose: () => {}
    })
    const desktop = getSelfHostedRelayConfig(
      {
        url: origin,
        accessKey
      },
      true
    )!
    const context = selfHostedRelayAuthContext(desktop)
    broker = await RelaySessionBroker.connect({
      relayProvider: 'self-hosted',
      authConfig: desktop,
      accessToken: context.accessToken,
      identity: context.identity,
      keypair,
      appVersion: 'test',
      mobileSocketWiring: wiring,
      isCurrent: () => true,
      refreshAccessToken: async () => ({ accessToken: context.accessToken }),
      onStatus: () => {},
      fetch: fetchRelay,
      createControlSocket: (url, token) => connectSocket(url, { authorization: `Bearer ${token}` }),
      createDataSocket: (url) => connectSocket(url)
    })
    const offer = await broker.createPairingRelay(device.deviceId)
    expect(
      PairingOfferSchema.safeParse({
        v: 2,
        scope: 'mobile',
        endpoint: 'ws://192.168.1.2:6768',
        deviceToken: device.token,
        publicKeyB64: keypair.publicKeyB64,
        relay: offer
      }).success
    ).toBe(true)
    expect(JSON.stringify(offer)).not.toContain(accessKey)

    const connectPhone = async (credential: string) => {
      const phone = connectSocket(
        `${origin.replace('https:', 'wss:')}/v1/connect/${offer.relayHostId}`
      )
      await once(phone, 'open')
      const hello = nextText(phone)
      phone.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential }))
      expect(JSON.parse(await hello)).toMatchObject({ type: 'relay-hello', ok: true })
      const peer = new SimulatedMobileE2EEV2Peer(
        nacl.box.keyPair(),
        keys.publicKey,
        offer.relayHostId
      )
      const ready = nextText(phone)
      phone.send(JSON.stringify(peer.hello))
      expect(peer.acceptReady(JSON.parse(await ready))).toBe(true)
      const authenticated = nextText(phone)
      phone.send(
        peer.sealText(
          JSON.stringify({
            type: 'e2ee_auth',
            v: 2,
            transcriptHashB64: peer.transcriptHashB64,
            deviceToken: device.token
          })
        )
      )
      expect(peer.openText(await authenticated)).toContain('e2ee_authenticated')
      const reply = nextText(phone)
      phone.send(peer.sealText('paired phone request'))
      expect(peer.openText(await reply)).toBe(
        JSON.stringify({ ok: true, echo: 'paired phone request' })
      )
      return phone
    }
    const phone = await connectPhone(offer.inviteToken)
    const transport = authenticatedSocket?.transport
    if (!transport || transport.transport !== 'relay') {
      throw new Error('expected relay-authenticated phone')
    }
    const resumeToken = randomBytes(32).toString('base64url')
    await broker.installCredential(
      device.deviceId,
      {
        reqId: 'install-resume',
        newResumeTokenHash: createHash('sha256').update(resumeToken).digest('base64url')
      },
      { mode: 'relay-basis', basisConnId: transport.basisConnId }
    )
    phone.terminate()
    const resumed = await connectPhone(resumeToken)
    expect(authenticatedSocket?.transport).toMatchObject({
      transport: 'relay',
      relayProvider: 'self-hosted',
      credentialKind: 'resume'
    })
    await broker.revokeDevice(device.deviceId)
    resumed.terminate()
    const rejected = connectSocket(
      `${origin.replace('https:', 'wss:')}/v1/connect/${offer.relayHostId}`
    )
    await once(rejected, 'open')
    const rejectedHello = nextText(rejected)
    rejected.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: resumeToken })
    )
    expect(JSON.parse(await rejectedHello)).toMatchObject({ ok: false })
  } finally {
    broker?.closeNow()
    for (const socket of sockets) {
      socket.terminate()
    }
    relay.sessions.drain(0)
    if ('closeAllConnections' in relay.server) {
      relay.server.closeAllConnections()
    }
    await new Promise<void>((resolve) => relay.server.close(() => resolve()))
    await database.close()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
