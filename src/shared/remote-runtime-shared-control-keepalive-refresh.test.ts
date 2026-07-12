import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestSharedControl } from './remote-runtime-shared-control-requests'
import {
  refreshSharedControlPendingRequestTimeouts,
  resolveSharedControlPendingResponse
} from './remote-runtime-shared-control-state'
import type { SharedControlPendingRequest } from './remote-runtime-shared-control-types'

// Why: a keepalive frame on the shared-control socket is armed by an unrelated
// long-poll, not by any given pending short RPC. These fake-timer tests pin the
// deadline semantics: keepalives must NOT keep a stuck short RPC alive forever,
// but MAY extend a long-poll that opted into the short-RPC path.
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
    onTimeout: ReturnType<typeof vi.fn>
  } {
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()
    const onTimeout = vi.fn()
    const promise = requestSharedControl({
      pendingRequests,
      method: 'git.status',
      params: undefined,
      timeoutMs: 1000,
      // ensureReady resolves immediately; the request is "in flight" but the
      // server never answers, modelling a genuinely stuck server-side call.
      ensureReady: () => Promise.resolve(),
      send: () => undefined,
      onTimeout,
      refreshTimeoutOnKeepalive: options.refreshTimeoutOnKeepalive
    })
    // Swallow the eventual rejection so unhandled-rejection noise doesn't leak.
    promise.catch(() => undefined)
    return { pendingRequests, promise, onTimeout }
  }

  it('times out a stuck short RPC even while keepalive frames keep arriving', async () => {
    const { pendingRequests, promise, onTimeout } = startRequest()

    // Periodic keepalives arrive faster than the 1000ms deadline — as they
    // would while a long-poll subscription streams over the same socket.
    for (let elapsed = 0; elapsed < 1000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
    }
    await vi.advanceTimersByTimeAsync(1)

    await expect(promise).rejects.toThrow()
    // The stuck-request path tears the connection down so reconnect+replay runs.
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(pendingRequests.size).toBe(0)
  })

  it('keeps refreshing a long-poll request that opted into keepalive refresh', async () => {
    const { pendingRequests, promise, onTimeout } = startRequest({
      refreshTimeoutOnKeepalive: true
    })

    // Same keepalive cadence, but this request opted in, so each keepalive
    // pushes the deadline out and it never fires.
    for (let elapsed = 0; elapsed < 3000; elapsed += 200) {
      await vi.advanceTimersByTimeAsync(200)
      refreshSharedControlPendingRequestTimeouts(pendingRequests)
    }

    expect(onTimeout).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(1)

    // It still resolves normally once the server finally answers.
    const [requestId] = pendingRequests.keys()
    resolveSharedControlPendingResponse(pendingRequests, requestId!, {
      id: requestId!,
      ok: true,
      result: { done: true },
      _meta: { runtimeId: 'runtime-test' }
    })
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('fires the deadline for a short RPC when no keepalives arrive', async () => {
    const { pendingRequests, promise, onTimeout } = startRequest()

    await vi.advanceTimersByTimeAsync(1001)

    await expect(promise).rejects.toThrow()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(pendingRequests.size).toBe(0)
  })
})
