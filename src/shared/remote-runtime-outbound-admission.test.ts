import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { generateKeyPair, publicKeyToBase64 } from './e2ee-crypto'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'
import { sendRemoteRuntimeRequest, subscribeRemoteRuntimeRequest } from './remote-runtime-client'
import {
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_REQUESTS,
  REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_READY_WAITERS,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTIONS,
  retainedRemoteRuntimeJsonStringBytes,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'
import { getRemoteRuntimeRequestAdmissionEvidence } from './remote-runtime-prepared-request-admission'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { waitForSharedControlReadyWithTimeout } from './remote-runtime-shared-control-ready'

type InspectableRequestConnection = {
  close: () => void
  request: (method: string, params: unknown, timeoutMs: number) => Promise<unknown>
}

type RequestAdmissionState = {
  pendingRequests: Map<
    string,
    { preparedRequest?: { retainedBytes: number; serializedRequest?: string | null } | null }
  >
  readyWaiters: unknown[]
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
  it('rejects oversized requests before opening any desktop transport socket', async () => {
    const { pairing, server } = await createServer()
    const oversizedParams = { value: 'x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) }
    const cached = new RemoteRuntimeRequestConnection(pairing)
    const shared = new RemoteRuntimeSharedControlConnection(pairing)

    await expect(
      sendRemoteRuntimeRequest(pairing, 'status.get', oversizedParams, 1000)
    ).rejects.toThrow('JSON payload exceeds')
    await expect(cached.request('status.get', oversizedParams, 1000)).rejects.toThrow(
      'JSON payload exceeds'
    )
    await expect(shared.request('status.get', oversizedParams, 1000)).rejects.toThrow(
      'JSON payload exceeds'
    )
    await expect(
      subscribeRemoteRuntimeRequest(pairing, 'terminal.subscribe', oversizedParams, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn()
      })
    ).rejects.toThrow('JSON payload exceeds')

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(server.clients.size).toBe(0)
    cached.close()
    shared.close()
  })

  it('rejects shared-control subscription count and byte overload before connecting', async () => {
    const { pairing, server } = await createServer()
    const connection = new RemoteRuntimeSharedControlConnection(pairing)
    const subscriptions = (
      connection as unknown as {
        subscriptions: Map<string, { retainedParamsBytes: number }>
      }
    ).subscriptions
    for (let index = 0; index < REMOTE_RUNTIME_MAX_SUBSCRIPTIONS; index += 1) {
      subscriptions.set(`subscription-${index}`, { retainedParamsBytes: 0 })
    }

    await expect(
      connection.subscribe('files.watch', null, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn()
      })
    ).rejects.toThrow('subscription limit reached')

    subscriptions.clear()
    subscriptions.set('aggregate', {
      retainedParamsBytes: REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES
    })
    await expect(
      connection.subscribe('files.watch', null, 1000, {
        onResponse: vi.fn(),
        onError: vi.fn()
      })
    ).rejects.toThrow('subscription memory limit reached')

    expect(server.clients.size).toBe(0)
    subscriptions.clear()
    connection.close()
  })

  it('bounds aggregate prepared bytes across stalled one-shot sockets', async () => {
    const { pairing, server } = await createServer()
    const params = { value: 'x'.repeat(3 * 1024 * 1024) }
    const retainedBytes = retainedRemoteRuntimeJsonStringBytes(
      serializeRemoteRuntimeRpcRequest({
        requestId: '00000000-0000-4000-8000-000000000000',
        deviceToken: pairing.deviceToken,
        method: 'status.large',
        params
      })
    )
    const admittedCount = Math.floor(REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES / retainedBytes)
    const requests = Array.from({ length: admittedCount }, () =>
      sendRemoteRuntimeRequest(pairing, 'status.large', params, 60_000).catch(() => undefined)
    )

    await expect(
      sendRemoteRuntimeRequest(pairing, 'status.overflow', params, 60_000)
    ).rejects.toMatchObject({ code: 'remote_runtime_busy' })
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(admittedCount)

    await vi.waitFor(() => expect(server.clients.size).toBe(admittedCount))
    for (const client of server.clients) {
      client.close()
    }
    await Promise.all(requests)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it('bounds pending requests and ready waiters while both handshakes stall', async () => {
    const { pairing } = await createServer()
    const connections: InspectableRequestConnection[] = [
      new RemoteRuntimeRequestConnection(pairing),
      new RemoteRuntimeSharedControlConnection(pairing)
    ]

    for (const connection of connections) {
      const requests = Array.from({ length: REMOTE_RUNTIME_MAX_PENDING_REQUESTS }, (_, index) =>
        connection.request(`status.${index}`, undefined, 60_000).catch(() => undefined)
      )
      await expect(connection.request('status.overflow', undefined, 60_000)).rejects.toMatchObject({
        code: 'remote_runtime_busy'
      })
      const state = connection as unknown as RequestAdmissionState
      expect(state.pendingRequests.size).toBe(REMOTE_RUNTIME_MAX_PENDING_REQUESTS)
      expect(state.readyWaiters).toHaveLength(REMOTE_RUNTIME_MAX_PENDING_REQUESTS)

      connection.close()
      await Promise.all(requests)
      expect(state.pendingRequests.size).toBe(0)
      expect(state.readyWaiters).toHaveLength(0)
    }
  })

  it('bounds aggregate prepared request text while both handshakes stall', async () => {
    const { pairing } = await createServer()
    const params = { value: 'x'.repeat(3 * 1024 * 1024) }
    const retainedBytes = retainedRemoteRuntimeJsonStringBytes(
      serializeRemoteRuntimeRpcRequest({
        requestId: '00000000-0000-4000-8000-000000000000',
        deviceToken: pairing.deviceToken,
        method: 'status.large',
        params
      })
    )
    const admittedCount = Math.floor(REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES / retainedBytes)
    expect(admittedCount).toBeGreaterThan(0)

    for (const connection of [
      new RemoteRuntimeRequestConnection(pairing),
      new RemoteRuntimeSharedControlConnection(pairing)
    ] satisfies InspectableRequestConnection[]) {
      const requests = Array.from({ length: admittedCount }, () =>
        connection.request('status.large', params, 60_000).catch(() => undefined)
      )
      await expect(connection.request('status.overflow', params, 60_000)).rejects.toMatchObject({
        code: 'remote_runtime_busy'
      })
      const state = connection as unknown as RequestAdmissionState
      const retainedTotal = Array.from(state.pendingRequests.values()).reduce(
        (total, pending) => total + (pending.preparedRequest?.retainedBytes ?? 0),
        0
      )
      expect(retainedTotal).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES)

      connection.close()
      await Promise.all(requests)
      expect(state.pendingRequests.size).toBe(0)
      expect(state.readyWaiters).toHaveLength(0)
    }
  })

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
      sendRemoteRuntimeRequest(pairing, 'status.one-shot-overflow', undefined, 60_000)
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

  it('releases one-shot process admission after a stalled handshake times out', async () => {
    const { pairing } = await createServer()
    const request = sendRemoteRuntimeRequest(pairing, 'status.timeout', undefined, 25)

    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(1)
    await expect(request).rejects.toMatchObject({ code: 'runtime_timeout' })
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it('bounds retained request bytes across stalled environment connections', async () => {
    const { pairing } = await createServer()
    const params = { value: 'x'.repeat(1024 * 1024) }
    const retainedBytes = retainedRemoteRuntimeJsonStringBytes(
      serializeRemoteRuntimeRpcRequest({
        requestId: '00000000-0000-4000-8000-000000000000',
        deviceToken: pairing.deviceToken,
        method: 'status.large',
        params
      })
    )
    const admittedCount = Math.floor(REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES / retainedBytes)
    const connections: InspectableRequestConnection[] = [
      new RemoteRuntimeRequestConnection(pairing),
      new RemoteRuntimeSharedControlConnection(pairing),
      new RemoteRuntimeRequestConnection(pairing)
    ]
    expect(Math.ceil(admittedCount / connections.length) * retainedBytes).toBeLessThan(
      REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES
    )
    const requests = Array.from({ length: admittedCount }, (_, index) =>
      connections[index % connections.length]!.request('status.large', params, 60_000).catch(
        () => undefined
      )
    )

    await expect(
      connections[admittedCount % connections.length]!.request('status.overflow', params, 60_000)
    ).rejects.toMatchObject({ code: 'remote_runtime_busy' })
    const evidence = getRemoteRuntimeRequestAdmissionEvidence()
    expect(evidence.pendingRequestCount).toBe(admittedCount)
    expect(evidence.retainedBytes).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_PROCESS_PENDING_RPC_BYTES)

    connections.forEach((connection) => connection.close())
    await Promise.all(requests)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
  })

  it('releases pending state and ready waiters when stalled handshakes time out', async () => {
    const { pairing } = await createServer()

    for (const connection of [
      new RemoteRuntimeRequestConnection(pairing),
      new RemoteRuntimeSharedControlConnection(pairing)
    ] satisfies InspectableRequestConnection[]) {
      const request = connection.request('status.timeout', { value: 'x'.repeat(1024) }, 100)
      const state = connection as unknown as RequestAdmissionState
      expect(state.pendingRequests.size).toBe(1)
      expect(state.readyWaiters).toHaveLength(1)
      expect(
        Array.from(state.pendingRequests.values())[0]?.preparedRequest?.retainedBytes
      ).toBeGreaterThan(0)

      await expect(request).rejects.toBeInstanceOf(Error)
      await vi.waitFor(() => expect(state.readyWaiters).toHaveLength(0))
      expect(state.pendingRequests.size).toBe(0)
      connection.close()
    }
  })

  it('rejects ready waiters beyond the combined request and subscription bound', async () => {
    const readyWaiters: Parameters<typeof waitForSharedControlReadyWithTimeout>[0]['readyWaiters'] =
      []
    const admitted = Array.from({ length: REMOTE_RUNTIME_MAX_READY_WAITERS }, () =>
      waitForSharedControlReadyWithTimeout({
        readyWaiters,
        timeoutMs: 60_000,
        open: () => undefined
      }).catch(() => undefined)
    )
    const open = vi.fn()

    await expect(
      waitForSharedControlReadyWithTimeout({ readyWaiters, timeoutMs: 1000, open })
    ).rejects.toMatchObject({ code: 'remote_runtime_busy' })
    expect(readyWaiters).toHaveLength(REMOTE_RUNTIME_MAX_READY_WAITERS)
    expect(open).not.toHaveBeenCalled()

    for (const waiter of readyWaiters.splice(0)) {
      waiter.reject(new Error('test cleanup'))
    }
    await Promise.all(admitted)
    expect(readyWaiters).toHaveLength(0)
  })
})

async function createServer(): Promise<{ pairing: PairingOffer; server: WebSocketServer }> {
  const keyPair = generateKeyPair()
  const server = new WebSocketServer({ port: 0 })
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
  return { pairing, server }
}
