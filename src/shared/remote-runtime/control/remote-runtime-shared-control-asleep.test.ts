import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'
import { RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE } from '../recipe-vm-wake'

afterEach(async () => {
  vi.useRealTimers()
  await closeSharedControlTestServers()
})

/** Past the longest reconnect backoff (5 minutes), so any armed or new retry would have dialed. */
const QUIET_WINDOW_MS = 10 * 60_000

// #36363: a sleeping VM's server must take no dial until its workspace wakes it.
describe('shared-control while the server VM is asleep', () => {
  it('makes zero connection attempts after the socket drops, then reconnects once awake', async () => {
    const server = await createSharedControlTestServer()
    let asleep = false
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      isAsleep: () => asleep
    })
    await connection.request('worktree.ps', undefined, 1_000)
    expect(server.connectionCount()).toBe(1)

    asleep = true
    server.closeClients()
    await vi.waitFor(() => expect(connection.getDiagnostics().state).toBe('closed'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)
    expect(connection.retryNow()).toBe(false)
    await expect(connection.request('repo.list', undefined, 1_000)).rejects.toMatchObject({
      code: RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE
    })
    expect(server.connectionCount()).toBe(1)
    vi.useRealTimers()

    asleep = false
    await expect(connection.request('repo.list', undefined, 1_000)).resolves.toMatchObject({
      ok: true
    })
    expect(server.connectionCount()).toBe(2)
    connection.close()
  })

  it('does not dial from a retry armed before the VM went to sleep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = await createSharedControlTestServer()
    let asleep = false
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing, {
      isAsleep: () => asleep
    })
    await connection.request('worktree.ps', undefined, 1_000)

    server.closeClients()
    await vi.waitFor(() => expect(connection.getDiagnostics().state).toBe('reconnecting'))
    asleep = true
    await vi.advanceTimersByTimeAsync(QUIET_WINDOW_MS)

    expect(server.connectionCount()).toBe(1)
    expect(connection.getDiagnostics().state).toBe('closed')
    connection.close()
  })
})
