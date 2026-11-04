import { RUNTIME_ORDINARY_MESSAGE_CAPABILITY } from '../../runtime-ordinary-message-capability'
import { sendRemoteRuntimeRequestOnSocket } from '../requests/remote-runtime-request-socket'
import { RemoteRuntimeRequestConnection } from '../requests/remote-runtime-request-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  retainedRemoteRuntimeJsonStringBytes,
  serializeRemoteRuntimeRpcRequest
} from '../remote-runtime-memory-limits'
import { getRemoteRuntimeRequestAdmissionEvidence } from '../requests/remote-runtime-prepared-request-admission'
import { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer as createServer
} from './remote-runtime-shared-control-test-server'

afterEach(closeSharedControlTestServers)

describe('RemoteRuntimeSharedControlConnection', () => {
  it.each(['cached', 'shared', 'one-shot'] as const)(
    'negotiates complete ordinary requests on the actual %s socket',
    async (kind) => {
      for (const supported of [false, true]) {
        const server = await createServer({
          resultForRequest: (method) =>
            method === 'status.get'
              ? { capabilities: supported ? [RUNTIME_ORDINARY_MESSAGE_CAPABILITY] : [] }
              : { text: 'z'.repeat(3 * 1024 * 1024) }
        })
        const cached = new RemoteRuntimeRequestConnection(server.pairing)
        const shared = new RemoteRuntimeSharedControlConnection(server.pairing)
        const request = (method: string, params: unknown) =>
          kind === 'cached'
            ? cached.request(method, params, 5000)
            : kind === 'shared'
              ? shared.request(method, params, 5000)
              : sendRemoteRuntimeRequestOnSocket(server.pairing, method, params, 5000)
        const params = { text: `${' '.repeat(3 * 1024 * 1024 - 1)}x` }
        try {
          if (supported) {
            await expect(request('agentSession.respondToApproval', params)).resolves.toMatchObject({
              ok: true,
              result: { text: 'z'.repeat(3 * 1024 * 1024) }
            })
            expect(
              server.requests.find((request) => request.method === 'agentSession.respondToApproval')
                ?.params
            ).toEqual(params)
          } else {
            await expect(request('agentSession.respondToApproval', params)).rejects.toMatchObject({
              code: 'invalid_argument'
            })
            expect(server.requests.map((request) => request.method)).toEqual(['status.get'])
          }
          await expect(request('status.get', null)).resolves.toMatchObject({ ok: true })
        } finally {
          cached.close()
          shared.close()
        }
      }
    }
  )

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

  it('keeps sent request bytes admitted while a ready socket stops responding', async () => {
    const server = await createServer({
      silentMethods: ['worktree.large'],
      resultForRequest: () => ({ capabilities: [RUNTIME_ORDINARY_MESSAGE_CAPABILITY] })
    })
    const connection = new RemoteRuntimeSharedControlConnection(server.pairing)
    const params = { value: 'x'.repeat(3 * 1024 * 1024) }
    const retainedBytes = retainedRemoteRuntimeJsonStringBytes(
      serializeRemoteRuntimeRpcRequest({
        requestId: '00000000-0000-4000-8000-000000000000',
        deviceToken: server.pairing.credential.deviceToken,
        method: 'worktree.large',
        params
      })
    )
    const admittedCount = Math.floor(REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES / retainedBytes)
    const pendingRequests = (
      connection as unknown as {
        pendingRequests: Map<
          string,
          { preparedRequest?: { serializedRequest: string | null } | null }
        >
      }
    ).pendingRequests
    const requests = Array.from({ length: admittedCount }, () =>
      connection.request('worktree.large', params, 60_000).catch(() => undefined)
    )
    await vi.waitFor(() =>
      expect(server.requests.filter((request) => request.method === 'worktree.large')).toHaveLength(
        admittedCount
      )
    )

    expect(
      Array.from(pendingRequests.values()).every(
        (pending) => pending.preparedRequest?.serializedRequest === null
      )
    ).toBe(true)
    await expect(connection.request('worktree.large', params, 60_000)).rejects.toMatchObject({
      code: 'remote_runtime_busy'
    })
    expect(getRemoteRuntimeRequestAdmissionEvidence().retainedBytes).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES
    )

    connection.close()
    await Promise.all(requests)
    expect(getRemoteRuntimeRequestAdmissionEvidence()).toEqual({
      pendingRequestCount: 0,
      retainedBytes: 0
    })
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
