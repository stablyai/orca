import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const { runtimeCall, resetRemoteRuntimeTransport } = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

// A client that starts while its paired runtime is unreachable attaches to already-open panes rather
// than creating them, so the failure lands in attach() rather than connect(). attach() never sets
// `connected`, so the recoverable branch's scheduleResubscribeAfterTransportClose() returned at its
// `!connected` guard: nothing armed, `connecting` latched, no error surfaced. The pane rendered as a
// blank xterm bound to nothing, and stayed that way after the runtime came back.
describe('recoverable attach failures on a remote runtime pane', () => {
  let resolvePaneCalls = 0

  /** Rejects every RPC the way a paired runtime behind a dropped tunnel does. */
  function installUnreachableRuntime(): void {
    resolvePaneCalls = 0
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.resolvePane') {
        resolvePaneCalls += 1
      }
      throw Object.assign(new Error('Remote Orca runtime closed the connection.'), {
        code: 'remote_runtime_unavailable'
      })
    })
  }

  // Why: the client attaches to an already-open pane on the host rather than creating one, which is
  // the entry point a restored session uses and the one that had no retry armed.
  const persistedPaneAttach = {
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: 120,
    rows: 40
  } as const

  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('arms a retry when attach fails against an unreachable runtime', async () => {
    vi.useFakeTimers()
    try {
      installUnreachableRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({ ...persistedPaneAttach, callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(1)

      // Before the fix this stayed 'connecting' forever, which the banner filter hides — a blank
      // pane with no error and no retry.
      expect(resolvePaneCalls).toBe(1)
      expect(transport.getRecoveryState?.().phase).toBe('backoff')
      expect(onError).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1_000)
      expect(resolvePaneCalls).toBeGreaterThan(1)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a parked retry that revives the pane when the runtime returns', async () => {
    vi.useFakeTimers()
    try {
      installUnreachableRuntime()
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      // Why dynamic: resetRemoteRuntimeTransport() re-registers the module graph, and the retry
      // registry only sees panes from the same instance the transport was loaded from.
      const { retryAllRemoteRuntimePtyRecoveriesNow } = await import(
        './remote-runtime-pty-recovery-state'
      )
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({ ...persistedPaneAttach, callbacks: {} })
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)

      // An hours-long outage outlives the auto-recovery window, so the latch must stay revivable.
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      const callsAtCutoff = resolvePaneCalls

      // This is what an environment-reachable trigger fires; it found nothing before the fix.
      expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(resolvePaneCalls).toBeGreaterThan(callsAtCutoff)

      // ...and the Reconnect button must work too.
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.retryRecovery?.()).toBe(true)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still surfaces a non-recoverable attach failure instead of retrying it', async () => {
    vi.useFakeTimers()
    try {
      resolvePaneCalls = 0
      runtimeCall.mockImplementation(async (args: { method: string }) => {
        if (args.method === 'terminal.resolvePane') {
          resolvePaneCalls += 1
        }
        throw new Error('boom')
      })
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { getScheduledRemoteRuntimePtyRecoveryCountForTests } = await import(
        './remote-runtime-pty-recovery-state'
      )
      const onError = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:1'
      })

      transport.attach({ ...persistedPaneAttach, callbacks: { onError } })
      await vi.advanceTimersByTimeAsync(1)

      // The red error surface stays reserved for actionable failures.
      expect(onError).toHaveBeenCalled()
      expect(getScheduledRemoteRuntimePtyRecoveryCountForTests()).toBe(0)

      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
