import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestSharedControl } from '../requests/remote-runtime-shared-control-requests'
import {
  refreshSharedControlPendingRequestTimeouts,
  resolveSharedControlPendingResponse
} from './remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

// Unrelated long-poll keepalives must extend only opted-in requests, never stuck short RPCs.
describe('shared control keepalive timeout refresh semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function startRequest(options: { refreshTimeoutOnKeepalive?: boolean } = {}): {
    pendingRequests: Map<string, SharedControlPendingRequest<unknown>>
    promise: Promise<unknown>
  } {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const promise = requestSharedControl({
      pendingRequests,
      deviceToken: 'device-token',
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      // Resolve readiness but never answer, modelling a stuck server call.
      ensureReady: () => Promise.resolve(),
      send: () => undefined,
      refreshTimeoutOnKeepalive: options.refreshTimeoutOnKeepalive
    })
    // Avoid unhandled rejection before the timeout assertion.
    promise.catch(() => undefined)
    return { pendingRequests, promise }
  }

  it('times out a stuck short RPC even while keepalive frames keep arriving', async () => {
    const { pendingRequests, promise } = startRequest()

    // Model unrelated long-poll keepalives arriving faster than the short-RPC deadline.
    for (let elapsed = 0; elapsed < 1000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
    }
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).rejects.toThrow()
    expect(pendingRequests.size).toBe(0)
  })

  it('keeps refreshing a long-poll request that opted into keepalive refresh', async () => {
    const { pendingRequests, promise } = startRequest({
      refreshTimeoutOnKeepalive: true
    })

    // Opted-in requests extend their deadline on each keepalive.
    for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
    }

    expect(pendingRequests.size).toBe(1)

    const [requestId] = pendingRequests.keys()
    resolveSharedControlPendingResponse(pendingRequests, requestId!, {
      id: requestId!,
      ok: true,
      result: { done: true },
      _meta: { runtimeId: 'runtime-test' }
    })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('aborts one pending request without disturbing its peer', async () => {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const controller = new AbortController()
    const start = (method: string, signal?: AbortSignal) =>
      requestSharedControl({
        pendingRequests,
        deviceToken: 'device-token',
        method,
        params: undefined,
        timeoutMs: 1000,
        ensureReady: () => Promise.resolve(),
        send: () => undefined,
        signal
      })
    const cancelled = start('worktree.hang', controller.signal)
    const survivor = start('worktree.ps')

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect([...pendingRequests.values()].map(({ method }) => method)).toEqual(['worktree.ps'])

    const [requestId] = pendingRequests.keys()
    resolveSharedControlPendingResponse(pendingRequests, requestId!, {
      id: requestId!,
      ok: true,
      result: { method: 'worktree.ps' },
      _meta: { runtimeId: 'runtime-test' }
    })
    await expect(survivor).resolves.toMatchObject({ ok: true })
  })
})
