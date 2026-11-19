import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../control/remote-runtime-shared-control-test-server'
import { RemoteRuntimeSharedControlConnection } from '../control/remote-runtime-shared-control-connection'
import type { RuntimeRpcResponse } from '../rpc/runtime-rpc-envelope'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'

const CONNECT_BUDGET_MS = 1_000
const RESPONSE_BUDGET_MS = 10_000

const silentServers: { server: Server; sockets: Socket[] }[] = []
const sharedConnections: RemoteRuntimeSharedControlConnection[] = []

afterEach(async () => {
  for (const connection of sharedConnections.splice(0)) {
    connection.close()
  }
  vi.useRealTimers()
  await closeSharedControlTestServers()
  await Promise.all(
    silentServers.splice(0).map(
      ({ server, sockets }) =>
        new Promise<void>((resolve) => {
          sockets.forEach((socket) => socket.destroy())
          server.close(() => resolve())
        })
    )
  )
})

async function until(check: () => boolean): Promise<void> {
  while (!check()) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function send(
  transport: 'one-shot' | 'shared',
  pairing: PairedRuntimeConnection
): Promise<RuntimeRpcResponse<unknown>> {
  if (transport === 'shared') {
    const shared = new RemoteRuntimeSharedControlConnection(pairing)
    sharedConnections.push(shared)
    return shared.request('aiVault.listSessions', {}, CONNECT_BUDGET_MS, undefined, undefined, {
      responseTimeoutMs: RESPONSE_BUDGET_MS
    })
  }
  return sendRemoteRuntimeRequestOnSocket(
    pairing,
    'aiVault.listSessions',
    {},
    CONNECT_BUDGET_MS,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    RESPONSE_BUDGET_MS
  )
}

async function expectFailureAfter(
  request: Promise<RuntimeRpcResponse<unknown>>,
  elapsedMs: number,
  code = 'runtime_timeout'
): Promise<void> {
  let settled = false
  void request.then(
    () => (settled = true),
    () => (settled = true)
  )
  await vi.advanceTimersByTimeAsync(elapsedMs - 1)
  expect(settled).toBe(false)
  const refused = expect(request).rejects.toMatchObject({ code })
  await vi.advanceTimersByTimeAsync(1)
  await refused
}

describe.each(['one-shot', 'shared'] as const)('%s request response budget', (transport) => {
  // The shared socket reports a connect that never became ready as unavailable.
  const connectFailureCode =
    transport === 'shared' ? 'remote_runtime_unavailable' : 'runtime_timeout'

  it('fails an unanswered dial at the connect budget', async () => {
    const sockets: Socket[] = []
    const server = createServer((socket) => sockets.push(socket))
    silentServers.push({ server, sockets })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Silent server has no TCP address')
    }
    const { pairing } = await createSharedControlTestServer()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const request = send(transport, { ...pairing, endpoint: `ws://127.0.0.1:${address.port}` })
    await until(() => sockets.length === 1)

    await expectFailureAfter(request, CONNECT_BUDGET_MS, connectFailureCode)
  })

  it('fails an unanswered handshake at the connect budget', async () => {
    const server = await createSharedControlTestServer({ suppressReadyFrame: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const request = send(transport, server.pairing)
    await until(() => server.connectionCount() === 1)

    await expectFailureAfter(request, CONNECT_BUDGET_MS, connectFailureCode)
    expect(server.requests).toEqual([])
  })

  it('waits past the connect budget for a slow reply from an authenticated host', async () => {
    const server = await createSharedControlTestServer({
      delayedMethods: ['aiVault.listSessions']
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const request = send(transport, server.pairing)
    await until(() => server.requests.length === 1)
    await vi.advanceTimersByTimeAsync(RESPONSE_BUDGET_MS - 1)
    server.flushDelayedResponses()

    await expect(request).resolves.toMatchObject({ ok: true })
  })

  it('bounds the reply wait by the response budget', async () => {
    const server = await createSharedControlTestServer({ silentMethods: ['aiVault.listSessions'] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const request = send(transport, server.pairing)
    await until(() => server.requests.length === 1)

    await expectFailureAfter(request, RESPONSE_BUDGET_MS)
  })
})
