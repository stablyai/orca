import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { isRecoverableRemoteRuntimeConnectionError } from './remote-runtime-client-error-classification'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

// Longer than the first reconnect delay, so a scheduled retry would have dialed again.
const PAST_FIRST_RETRY_MS = 600

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('a shared control socket whose token the server refuses', () => {
  it('hands recovery to its owner instead of retrying the same refused token', async () => {
    const server = await createSharedControlTestServer({ rejectAuth: true })
    let finishRecovery: (next: 'retry' | 'stop') => void = () => {}
    const onAuthenticationRejected = vi.fn(
      () =>
        new Promise<'retry' | 'stop'>((resolve) => {
          finishRecovery = resolve
        })
    )
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      onAuthenticationRejected
    })

    const refused = await connection.request('status.get', undefined, 1_000).catch((e) => e)
    // Waiting callers see a connection that will return, not a refusal, while it re-pairs.
    expect(isRecoverableRemoteRuntimeConnectionError(refused)).toBe(true)
    expect(onAuthenticationRejected).toHaveBeenCalledOnce()

    finishRecovery('stop')
    await wait(PAST_FIRST_RETRY_MS)
    expect(server.connectionCount()).toBe(1)
    expect(connection.getDiagnostics().state).not.toBe('reconnecting')
    connection.close()
  })

  it('retries with backoff when its owner did not replace it', async () => {
    const server = await createSharedControlTestServer({ rejectAuth: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      onAuthenticationRejected: () => Promise.resolve('retry')
    })

    await connection.request('status.get', undefined, 1_000).catch(() => undefined)
    await vi.waitFor(() => expect(server.connectionCount()).toBeGreaterThan(1), {
      timeout: 2_000
    })
    connection.close()
  })

  it('keeps the usual reconnect for a server nobody re-pairs', async () => {
    const server = await createSharedControlTestServer({ rejectAuth: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      onAuthenticationRejected: () => null
    })

    const refused = await connection.request('status.get', undefined, 1_000).catch((e) => e)
    expect(refused).toMatchObject({ code: 'unauthorized' })
    await vi.waitFor(() => expect(server.connectionCount()).toBeGreaterThan(1), {
      timeout: 2_000
    })
    connection.close()
  })
})
