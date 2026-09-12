import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from './remote-runtime-shared-control-test-server'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeSharedControlTestServers()
})

describe('shared-control standing intent', () => {
  it('reconnects an idle established connection after the socket drops', async () => {
    const server = await createSharedControlTestServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    await connection.request('worktree.ps', undefined, 1_000)

    server.closeClients()

    await waitFor(() => connection.getDiagnostics().state === 'reconnecting')
    await waitFor(() => server.connectionCount() >= 2, 2_000)
    await expect(connection.request('repo.list', undefined, 1_000)).resolves.toMatchObject({
      ok: true
    })
    connection.close()
  })

  it('keeps recovery armed when the last subscription closes', async () => {
    const server = await createSharedControlTestServer()
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const subscription = await connection.subscribe(
      'session.tabs.subscribeAll',
      {},
      1_000,
      callbacks()
    )

    server.closeClients()
    await waitFor(() => connection.getDiagnostics().state === 'reconnecting')
    subscription.close()

    expect(connection.getDiagnostics()).toMatchObject({
      state: 'reconnecting',
      subscriptionCount: 0
    })
    await waitFor(() => server.connectionCount() >= 2, 2_000)
    connection.close()
  })

  it('selects the 5-minute idle ceiling and preserves the 30-second active ceiling', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const idle = testConnection()
    setReconnectAttempt(idle, 100)
    closeCurrentGeneration(idle)
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 300_000)
    idle.close()

    const active = testConnection()
    addLogicalSubscription(active)
    setReconnectAttempt(active, 100)
    closeCurrentGeneration(active)
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000)
    active.close()
  })

  it('retries indefinitely at the idle ceiling with bounded jitter', () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    const scheduler = new SharedControlReconnectScheduler()
    ;(scheduler as unknown as { attempt: number }).attempt = 100
    let opens = 0
    const open = (): void => {
      opens += 1
      scheduler.scheduleWithIdleBackoff(false, open)
    }

    scheduler.scheduleWithIdleBackoff(false, open)
    expect(timerSpy).toHaveBeenLastCalledWith(expect.any(Function), 360_000)
    vi.advanceTimersByTime(360_000 * 4)

    expect(opens).toBe(4)
    expect(scheduler.attemptCount).toBe(105)
    scheduler.clear()
  })

  it.each([
    { manual: false, paused: false, subscriptions: 0, scheduled: true },
    { manual: false, paused: false, subscriptions: 1, scheduled: true },
    { manual: false, paused: true, subscriptions: 0, scheduled: false },
    { manual: false, paused: true, subscriptions: 1, scheduled: true },
    { manual: true, paused: false, subscriptions: 0, scheduled: false },
    { manual: true, paused: false, subscriptions: 1, scheduled: false },
    { manual: true, paused: true, subscriptions: 0, scheduled: false },
    { manual: true, paused: true, subscriptions: 1, scheduled: false }
  ])(
    'applies the intent/capability truth table: $manual/$paused/$subscriptions',
    ({ manual, paused, subscriptions, scheduled }) => {
      vi.useFakeTimers()
      const connection = testConnection({ manual, paused })
      if (subscriptions > 0) {
        addLogicalSubscription(connection)
      }

      closeCurrentGeneration(connection)

      expect(connection.getDiagnostics().state === 'reconnecting').toBe(scheduled)
      connection.close()
    }
  )

  it('advances an armed idle retry without recreating cleared work', () => {
    vi.useFakeTimers()
    const connection = testConnection()
    const open = replaceOpen(connection)
    closeCurrentGeneration(connection)

    expect(connection.retryNow()).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(connection.retryNow()).toBe(false)
    connection.close()
  })

  it('clears an armed idle retry on close and ignores a late socket close', () => {
    vi.useFakeTimers()
    const connection = testConnection()
    const open = replaceOpen(connection)
    const generation = currentGeneration(connection)
    invokeSocketClose(connection, generation)
    connection.close()

    vi.runAllTimers()
    invokeSocketClose(connection, generation)

    expect(open).not.toHaveBeenCalled()
    expect(connection.getDiagnostics().state).toBe('closed')
  })
})

function testConnection(options?: {
  manual?: boolean
  paused?: boolean
}): RemoteRuntimeSharedControlConnection {
  return new RemoteRuntimeSharedControlConnection(
    {
      v: 2,
      endpoint: 'ws://127.0.0.1:1',
      deviceToken: 'token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    },
    {
      isManuallyDisconnected: () => options?.manual ?? false,
      isCapabilityPaused: () => options?.paused ?? false
    }
  )
}

function callbacks() {
  return {
    onResponse: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn()
  }
}

function addLogicalSubscription(connection: RemoteRuntimeSharedControlConnection): void {
  const subscription: SharedControlLogicalSubscription = {
    requestId: 'subscription-1',
    method: 'files.watch',
    params: {},
    retainedParamsBytes: 2,
    callbacks: callbacks(),
    sent: false,
    closed: false,
    closeAfterReady: false,
    remoteSubscriptionId: null
  }
  unsafeConnection(connection).subscriptions.set(subscription.requestId, subscription)
}

function currentGeneration(connection: RemoteRuntimeSharedControlConnection): number {
  return unsafeConnection(connection).socketGeneration.begin()
}

function closeCurrentGeneration(connection: RemoteRuntimeSharedControlConnection): void {
  invokeSocketClose(connection, currentGeneration(connection))
}

function invokeSocketClose(
  connection: RemoteRuntimeSharedControlConnection,
  generation: number
): void {
  unsafeConnection(connection).handleSocketClosed(
    new RemoteRuntimeClientError('runtime_unavailable', 'test close'),
    generation
  )
}

function setReconnectAttempt(
  connection: RemoteRuntimeSharedControlConnection,
  attempt: number
): void {
  unsafeConnection(connection).reconnect.attempt = attempt
}

function replaceOpen(connection: RemoteRuntimeSharedControlConnection): ReturnType<typeof vi.fn> {
  const open = vi.fn()
  unsafeConnection(connection).open = open
  return open
}

function unsafeConnection(connection: RemoteRuntimeSharedControlConnection): {
  open: () => void
  handleSocketClosed: (error: RemoteRuntimeClientError, generation: number) => void
  socketGeneration: { begin: () => number }
  subscriptions: Map<string, SharedControlLogicalSubscription>
  reconnect: { attempt: number }
} {
  return connection as never
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for shared-control state')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
