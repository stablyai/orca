import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from './pairing/paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { generateKeyPair, publicKeyToBase64 } from './e2ee/node/e2ee-crypto'
import { encodePairingOffer, parsePairingCode } from './pairing/pairing'
import { sendRemoteRuntimeRequestOnSocket } from './requests/remote-runtime-request-socket'
import { REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS } from './remote-runtime-memory-limits'
import { getRemoteRuntimeRequestAdmissionEvidence } from './requests/remote-runtime-prepared-request-admission'
import { RemoteRuntimeRequestConnection } from './requests/remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from './control/remote-runtime-shared-control-connection'

type InspectableRequestConnection = {
  close: () => void
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>
}

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
  expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
    pendingRequestCount: 0,
    retainedBytes: 0
  })
})

describe('remote runtime outbound admission', () => {
  it('bounds pending request count across stalled environment connections', async () => {
    const { pairing } = await createServer()
    const connections: InspectableRequestConnection[] = [
      new RemoteRuntimeRequestConnection(pairing),
      new RemoteRuntimeSharedControlConnection(pairing)
    ]
    const requests = Array.from(
      { length: REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS },
      (_, index) =>
        connections[index % connections.length]!.request(
          `status.${index}`,
          undefined,
          60_000
        ).catch(() => undefined)
    )
    const overflow = new RemoteRuntimeRequestConnection(pairing)

    await expect(overflow.request('status.overflow', undefined, 60_000)).rejects.toMatchObject({
      code: 'remote_runtime_busy'
    })
    await expect(
      sendRemoteRuntimeRequestOnSocket(
        pairing,
        'status.one-shot-overflow',
        undefined,
        60_000,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toMatchObject({ code: 'remote_runtime_busy' })
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(
      REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS
    )

    overflow.close()
    connections.forEach((connection) => connection.close())
    await Promise.all(requests)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })
})

async function createServer(): Promise<{
  pairing: PairedRuntimeConnection
  server: WebSocketServer
}> {
  const keyPair = generateKeyPair()
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(keyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }
  return { pairing: pairedRuntimeConnectionFromOffer(pairing), server }
}
