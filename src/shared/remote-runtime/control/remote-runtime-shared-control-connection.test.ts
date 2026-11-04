import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../requests/remote-runtime-prepared-request-admission'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

describe('RemoteRuntimeSharedControlConnection', () => {
  it('keeps a waiting request alive when a reachability probe replaces its pre-ready socket', async () => {
    const server = await createServer({ suppressReadyFrameCount: 1 })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)

    const response = connection.request('worktree.ps', undefined, 1000)
    await vi.waitFor(() => expect(server.connectionCount()).toBe(1))

    connection.reconnectNow()

    await expect(response).resolves.toMatchObject({
      ok: true,
      result: { method: 'worktree.ps' }
    })
    expect(server.connectionCount()).toBe(2)
    expect(server.requests.map(({ method }) => method)).toEqual(['worktree.ps'])
    expect(connection.getDiagnostics().pendingRequestCount).toBe(0)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
    connection.close()
  })

  it('cleans up an id-scoped subscription closed before its ready response', async () => {
    const server = await createServer({ delaySubscriptionReady: true })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const onAccounts = vi.fn()

    const accounts = await connection.subscribe('accounts.subscribe', null, 1000, {
      onResponse: onAccounts,
      onError: vi.fn()
    })
    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual(['accounts.subscribe'])
    )

    accounts.close()
    server.flushDelayedResponses()

    await vi.waitFor(() =>
      expect(server.requests.map((request) => request.method)).toEqual([
        'accounts.subscribe',
        'accounts.unsubscribe'
      ])
    )
    expect(onAccounts).not.toHaveBeenCalled()

    connection.close()
  })

  it('keeps unrelated pending requests alive when one request times out', async () => {
    const server = await createServer({
      silentMethods: ['worktree.hang'],
      delayedMethods: ['worktree.ps']
    })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const unsafe = connection as unknown as {
      pendingRequests: Map<
        string,
        {
          method: string
          preparedRequest?: { retainedBytes: number; serializedRequest: string | null } | null
        }
      >
    }

    const timedOut = connection.request('worktree.hang', undefined, 250)
    void timedOut.catch(() => undefined)
    await vi.waitFor(() =>
      expect(server.requests.map(({ method }) => method)).toContain('worktree.hang')
    )
    const survivor = connection.request('worktree.ps', undefined, 1000).then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await vi.waitFor(() =>
      expect(server.requests.map(({ method }) => method)).toContain('worktree.ps')
    )
    expect(
      Array.from(unsafe.pendingRequests.values()).every(
        (pending) =>
          pending.preparedRequest?.serializedRequest === null &&
          pending.preparedRequest.retainedBytes > 0
      )
    ).toBe(true)
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(2)

    await expect(timedOut).rejects.toThrow('Timed out')
    // One slow RPC does not prove shared-socket death; connection liveness owns that decision.
    expect(connection.getDiagnostics()).toMatchObject({ state: 'ready', pendingRequestCount: 1 })
    expect(getRemoteRuntimeRequestAdmissionEvidence().pendingRequestCount).toBe(1)

    server.flushDelayedResponses()
    await expect(survivor).resolves.toMatchObject({
      ok: true,
      response: { ok: true, result: { method: 'worktree.ps' } }
    })
    expect(unsafe.pendingRequests.size).toBe(0)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
    expect(server.connectionCount()).toBe(1)

    connection.close()
  })
})

it('cancels a pending subscription setup without canceling a sibling on the shared connection', async () => {
  const server = await createServer({ suppressReadyFrame: true })
  const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
  const controller = new AbortController()
  const callbacks = { onResponse: vi.fn(), onError: vi.fn() }
  try {
    const pending = connection.subscribe(
      'files.watch',
      { worktree: 'one' },
      10_000,
      callbacks,
      controller.signal
    )
    const abandoned = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const sibling = connection.subscribe('files.watch', { worktree: 'two' }, 10_000, callbacks)
    const siblingClosed = expect(sibling).rejects.toThrow('Remote Orca runtime')
    await vi.waitFor(() => expect(server.connectionCount()).toBe(1))
    controller.abort()
    await abandoned
    expect(connection.getDiagnostics()).toMatchObject({ subscriptionCount: 1 })
    expect(server.requests).toEqual([])
    connection.close()
    await siblingClosed
    expect(connection.getDiagnostics()).toMatchObject({ subscriptionCount: 0 })
  } finally {
    connection.close()
  }
})
