import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { MAX_IDLE_RECONNECT_ATTEMPTS } from './remote-runtime-shared-control-reconnect'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'

afterEach(() => {
  vi.useRealTimers()
})

describe('shared-control connection to a server that is gone', () => {
  it('stops redialing after the idle cap, then dials and resumes backoff once used', async () => {
    const server = await createSharedControlTestServer()
    await closeSharedControlTestServers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let closes = 0
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      onSocketClosed: () => {
        closes += 1
      }
    })

    await expect(connection.request('status.get', undefined, 1_000)).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    for (let attempt = 1; attempt <= MAX_IDLE_RECONNECT_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersToNextTimerAsync()
      await vi.waitFor(() => expect(closes).toBe(attempt + 1), { interval: 1 })
    }

    expect(vi.getTimerCount()).toBe(0)
    expect(connection.getDiagnostics().state).toBe('closed')

    await expect(connection.request('status.get', undefined, 1_000)).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })

    expect(closes).toBe(MAX_IDLE_RECONNECT_ATTEMPTS + 2)
    expect(connection.getDiagnostics()).toMatchObject({
      state: 'reconnecting',
      reconnectAttempt: 1
    })
    connection.close()
  })
})
