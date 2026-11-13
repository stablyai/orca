import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRequestGuard, RuntimeRpcResponse } from '../../runtime-rpc-envelope'
import { RemoteRuntimeSharedControlConnection } from '../control/remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../control/remote-runtime-shared-control-test-server'
import { sendRemoteRuntimeRequestOnSocket } from './remote-runtime-request-socket'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const connections: RemoteRuntimeSharedControlConnection[] = []
afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.close()
  }
  vi.useRealTimers()
  await closeSharedControlTestServers()
})

describe.each(['shared', 'one-shot'] as const)('%s request guard', (transport) => {
  async function setup() {
    const server = await createSharedControlTestServer()
    const shared = new RemoteRuntimeSharedControlConnection(server.pairing)
    connections.push(shared)
    const send = (
      prepareGuard: RuntimeRequestGuard,
      signal?: AbortSignal
    ): Promise<RuntimeRpcResponse<unknown>> =>
      transport === 'shared'
        ? shared.request(
            'repo.list',
            { path: 'kept' },
            1000,
            { orchestrationRequestId: 'guarded-request' },
            signal,
            { prepareGuard }
          )
        : sendRemoteRuntimeRequestOnSocket(
            server.pairing,
            'repo.list',
            { path: 'kept' },
            1000,
            { orchestrationRequestId: 'guarded-request' },
            undefined,
            signal,
            [],
            undefined,
            undefined,
            undefined,
            prepareGuard
          )
    return { server, send, close: () => shared.close() }
  }

  it('never dials or commits a cancelled delayed preflight', async () => {
    const { server, send, close } = await setup()
    const prepared = deferred<() => void>()
    const controller = new AbortController()
    let effects = 0
    const request = send(() => prepared.promise, controller.signal)
    const refused = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    prepared.resolve(() => {
      effects++
    })
    await refused
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(server.connectionCount()).toBe(0)
    expect(server.requests).toEqual([])
    expect(effects).toBe(0)
    close()
  })

  it('refreshes invalidated prepared inputs before sending the original frame', async () => {
    const { server, send, close } = await setup()
    let checks = 0
    await expect(
      send(async () => {
        const observed = ++checks
        return () => observed !== 2
      })
    ).resolves.toMatchObject({ ok: true })
    expect(server.requests).toMatchObject([
      { method: 'repo.list', params: { path: 'kept' }, orchestrationRequestId: 'guarded-request' }
    ])
    close()
  })

  it('preserves a final domain refusal without sending the admitted action', async () => {
    const { server, send, close } = await setup()
    const entered = deferred<void>()
    const prepared = deferred<() => void>()
    const error = Object.assign(new Error('This Run was reset.'), {
      code: 'remote_link_closed',
      data: { effectsApplied: false }
    })
    let checks = 0
    const request = send(async () => {
      if (++checks === 1) {
        return () => {}
      }
      entered.resolve()
      return prepared.promise
    })
    const refused = expect(request).rejects.toBe(error)
    await entered.promise
    prepared.resolve(() => {
      throw error
    })
    await refused
    expect(server.requests).toEqual([])
    close()
  })

  it('releases a timed-out action while its final preparation remains pending', async () => {
    const { server, send, close } = await setup()
    const entered = deferred<void>()
    const prepared = deferred<() => void>()
    let checks = 0
    let effects = 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const request = send(async () => {
      if (++checks === 1) {
        return () => {}
      }
      entered.resolve()
      return prepared.promise
    })
    const refused = expect(request).rejects.toMatchObject({ code: 'runtime_timeout' })
    await entered.promise
    await vi.advanceTimersByTimeAsync(1001)
    vi.useRealTimers()
    await refused
    prepared.resolve(() => {
      effects++
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(effects).toBe(0)
    expect(server.requests).toEqual([])
    await expect(send(async () => () => {})).resolves.toMatchObject({ ok: true })
    expect(server.requests).toMatchObject([
      { params: { path: 'kept' }, orchestrationRequestId: 'guarded-request' }
    ])
    close()
  })
})
