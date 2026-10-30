import { resolveRemoteConnection } from '../../cli/runtime/runtime-remote-pairing'
import { createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { WebSocketServer, type ClientOptions } from 'ws'
import type * as WsModule from 'ws'
import {
  LOCAL_HTTPS_TEST_PRIVATE_KEY,
  LOCAL_HTTPS_TEST_CERTIFICATE
} from '../../main/browser/browser-local-https-test-certificate'
import { DesktopMobileE2EEV2Session } from '../../main/runtime/rpc/mobile-e2ee-v2-desktop-session'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from '../../main/ipc/runtime-environments/runtime-environment-pairing-verification'
import { generateKeyPair, publicKeyToBase64 } from '../e2ee-crypto'
import { encodePairingOffer } from '../pairing'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../protocol-version'
import { resolveEnvironment } from '../runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../runtime-environments'
import { sendRemoteRuntimeRequest, subscribeRemoteRuntimeRequest } from './remote-runtime-client'
import { RemoteRuntimeSharedControlConnection } from './control/remote-runtime-shared-control-connection'
import { createRemoteRuntimeSocketProtocol } from './remote-runtime-relay-protocol'

vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof WsModule>()
  const { LOCAL_HTTPS_TEST_CERTIFICATE: ca } =
    await import('../../main/browser/browser-local-https-test-certificate')
  return {
    ...actual,
    default: class extends actual.default {
      constructor(url: string | URL, options?: ClientOptions) {
        super(url, { ...options, ca })
      }
    }
  }
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  vi.unstubAllGlobals()
})

async function relayHost(dropInstallReply = false) {
  const keys = generateKeyPair()
  const hostKey = publicKeyToBase64(keys.publicKey)
  const relayHostId = createHash('sha256').update(keys.publicKey).digest('base64url').slice(0, 16)
  const http = createServer({
    key: LOCAL_HTTPS_TEST_PRIVATE_KEY,
    cert: LOCAL_HTTPS_TEST_CERTIFICATE
  })
  const wss = new WebSocketServer({ server: http })
  const methods: string[] = []
  const outerCredentials: string[] = []
  let resumeHash: string | null = null
  const status = {
    runtimeId: 'desktop-runtime',
    deviceScope: 'runtime',
    graphStatus: 'ready',
    rendererGraphEpoch: 1,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
  }
  wss.on('connection', (socket) => {
    let outer = false
    let authenticated = false
    let session: DesktopMobileE2EEV2Session | null = null
    socket.on('message', (data) => {
      const text = data.toString()
      if (!outer) {
        const auth = z
          .object({ type: z.literal('relay-auth'), credential: z.string() })
          .parse(JSON.parse(text))
        outerCredentials.push(auth.credential)
        const resume =
          resumeHash !== null &&
          createHash('sha256').update(auth.credential).digest('base64url') === resumeHash
        if (!resume && (resumeHash !== null || auth.credential !== 'I'.repeat(43))) {
          socket.send(JSON.stringify({ type: 'relay-hello', ok: false, code: 4401 }))
          socket.close(4401)
          return
        }
        outer = true
        socket.send(
          JSON.stringify({
            type: 'relay-hello',
            ok: true,
            credentialKind: resume ? 'resume' : 'invite',
            leaseExpiresAt: Date.now() + 30_000,
            ...(resume
              ? {
                  acceptedCredentialVersion: 1,
                  acceptedAs: 'current',
                  resumeExpiresAt: Date.now() + 60_000
                }
              : {})
          })
        )
        return
      }
      if (!session) {
        session = DesktopMobileE2EEV2Session.create({
          hello: JSON.parse(text),
          serverSecretKey: keys.secretKey,
          expectedContext: { transport: 'relay', relayHostId }
        })
        if (!session) {
          socket.close(4001)
          return
        }
        socket.send(JSON.stringify(session.ready))
        return
      }
      const plaintext = session.openText(text)
      if (!plaintext) {
        socket.close(4001)
        return
      }
      if (!authenticated) {
        const auth = z
          .object({ type: z.literal('e2ee_auth'), deviceToken: z.literal('desktop-token') })
          .parse(JSON.parse(plaintext))
        expect(auth.deviceToken).toBe('desktop-token')
        authenticated = true
        socket.send(
          session.sealText(
            JSON.stringify({
              type: 'e2ee_authenticated',
              v: 2,
              transcriptHashB64: session.transcriptHashB64
            })
          )
        )
        return
      }
      const request = z
        .object({ id: z.string(), method: z.string(), params: z.unknown().optional() })
        .parse(JSON.parse(plaintext))
      methods.push(request.method)
      let result: unknown = status
      if (request.method === 'pairing.provisionRelay') {
        const params = z
          .object({ reqId: z.string(), newResumeTokenHash: z.string() })
          .parse(request.params)
        resumeHash = params.newResumeTokenHash
        if (dropInstallReply) {
          dropInstallReply = false
          socket.close(1001)
          return
        }
        result = {
          v: 1,
          reqId: params.reqId,
          authorizationMode: 'relay-basis',
          currentVersion: 1,
          resumeExpiresAt: Date.now() + 60_000
        }
      }
      socket.send(
        session.sealText(
          JSON.stringify({
            id: request.id,
            ok: true,
            result,
            _meta: { runtimeId: status.runtimeId }
          })
        )
      )
      if (request.method === 'terminal.subscribe') {
        socket.send(session.sealBinary(new Uint8Array([42, 7])))
      }
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a bound relay port')
  }
  const origin = `https://127.0.0.1:${address.port}`
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) {
          socket.terminate()
        }
        wss.close(() => http.close(() => resolve()))
      })
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            v: 1,
            cellUrl: origin,
            assignmentEpoch: 1,
            leaseExpiresAt: Date.now() + 60_000
          })
        )
    )
  )
  const pairingCode = encodePairingOffer({
    v: 2,
    scope: 'runtime',
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'desktop-token',
    publicKeyB64: hostKey,
    pairedDeviceId: 'laptop',
    relay: {
      v: 1,
      directorUrl: origin,
      cellUrl: origin,
      assignmentEpoch: 1,
      relayHostId,
      inviteToken: 'I'.repeat(43),
      inviteExpiresAt: Date.now() + 60_000,
      e2eeFraming: 2
    }
  })
  return { pairingCode, methods, outerCredentials }
}

describe('desktop runtime over Relay', () => {
  it('recovers a committed credential after the install reply is lost', async () => {
    const host = await relayHost(true)
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-relay-recovery-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const args = { name: 'Desktop', pairingCode: host.pairingCode }
    expect((await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, args)).ok).toBe(false)
    const recovered = await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, args)
    if (!recovered.ok) {
      throw new Error(recovered.message)
    }
    expect(host.methods.filter((method) => method === 'pairing.provisionRelay')).toHaveLength(1)
  })

  it.each([401, 403])(
    'requests re-pairing when the director rejects a saved credential with %s',
    async (status) => {
      const host = await relayHost()
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-relay-auth-'))
      cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
      const paired = await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, {
        name: 'Desktop',
        pairingCode: host.pairingCode
      })
      if (!paired.ok) {
        throw new Error(paired.message)
      }
      const connection = getPreferredPairedRuntimeConnection(
        resolveEnvironment(userDataPath, paired.environment.id)
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status }))
      )
      const onAuthenticationRejected = vi.fn()
      const control = new RemoteRuntimeSharedControlConnection(connection, {
        onAuthenticationRejected
      })
      cleanups.push(() => control.close())
      await expect(control.request('status.get', undefined, 5000)).rejects.toMatchObject({
        code: 'unauthorized'
      })
      expect(onAuthenticationRejected).toHaveBeenCalledOnce()
    }
  )

  it('pairs over loopback-only advertised reach, saves resume credentials, and serves requests, shared control and encrypted terminal data', async () => {
    const host = await relayHost()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-relay-'))
    cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
    const paired = await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, {
      name: 'Desktop',
      pairingCode: host.pairingCode
    })
    if (!paired.ok) {
      throw new Error(paired.message)
    }
    expect(paired.environment).not.toHaveProperty('relayConnection')
    const saved = resolveEnvironment(userDataPath, paired.environment.id)
    const connection = getPreferredPairedRuntimeConnection(saved)
    expect(connection.relayConnection?.credentialKind).toBe('resume')
    const cliConnection = resolveRemoteConnection(userDataPath, null, saved.id)
    if (!cliConnection) {
      throw new Error('Expected a saved CLI connection')
    }
    await expect(
      sendRemoteRuntimeRequest(cliConnection, 'status.get', undefined, 5000)
    ).resolves.toMatchObject({ ok: true, result: { deviceScope: 'runtime' } })
    const control = new RemoteRuntimeSharedControlConnection(connection)
    cleanups.push(() => control.close())
    await expect(control.request('status.get', undefined, 5000)).resolves.toMatchObject({
      ok: true
    })
    const binary = new Promise<Uint8Array>((resolve, reject) => {
      void subscribeRemoteRuntimeRequest(connection, 'terminal.subscribe', undefined, 5000, {
        onResponse: () => {},
        onBinary: resolve,
        onError: reject
      }).then((subscription) => cleanups.push(() => subscription.close()), reject)
    })
    expect(Array.from(await binary)).toEqual([42, 7])
    expect(host.methods).toContain('pairing.provisionRelay')
    expect(host.outerCredentials[0]).toBe('I'.repeat(43))
    expect(host.outerCredentials.slice(1)).not.toContain('I'.repeat(43))
    const mismatched = {
      ...connection,
      hostPublicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
    }
    expect(() => createRemoteRuntimeSocketProtocol(mismatched)).toThrow('Relay host identity')
  })
})
