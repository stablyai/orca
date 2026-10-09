import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS } from './remote-runtime-disconnected-input-grace'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  runtimeSubscribe,
  subscriptionSendBinary,
  emitMultiplexReady,
  latestSubscribePayload,
  emitSnapshot,
  subscribeFrameCount,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

const unreachable = (): Error =>
  Object.assign(new Error('Could not connect to the remote Orca runtime.'), {
    code: 'remote_runtime_unavailable'
  })

function sentText(): string {
  return subscriptionSendBinary.mock.calls
    .map(([bytes]) => decodeTerminalStreamFrame(bytes))
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Input)
    .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    .join('')
}

function attachLatestStream(): void {
  const streamId = latestSubscribePayload().streamId
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: { type: 'subscribed', streamId, capabilities: { inputAck: 1 }, inputLedgerId: 'l-1' }
  })
  emitSnapshot(streamId, 'prompt$ ')
}

/** Subscribes fail until the host is reachable, then open a ready stream. */
function mockSubscribeUntilReachable(isReachable: () => boolean): void {
  runtimeSubscribe.mockImplementation(
    async (_args: unknown, callbacks: NonNullable<MultiplexSubscriptionCallbacks>) => {
      if (!isReachable()) {
        throw unreachable()
      }
      subscriptionCallbacks = callbacks
      queueMicrotask(emitMultiplexReady)
      return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
    }
  )
}

/** A connected desktop pane whose stream then drops, with resubscribes failing until reachable. */
async function connectThenLoseHost(isReachable: () => boolean) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  transport.attach({ existingPtyId: 'remote:terminal-1', cols: 80, rows: 24, callbacks: {} })
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
  attachLatestStream()
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  mockSubscribeUntilReachable(isReachable)
  subscriptionCallbacks?.onClose?.()
  return transport
}

describe('disconnected input grace across retries', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('delivers keys typed during a retry begun inside the grace that ends after it, in order', async () => {
    vi.useFakeTimers()
    try {
      let hostReachable = false
      const transport = await connectThenLoseHost(() => hostReachable)
      expect(transport.sendInput('STALE\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 10_000)

      expect(transport.retryRecovery?.()).toBe(true)
      expect(transport.sendInput('y\r', 'driving')).toBe(true)
      // The attempt is still failing when the grace runs out.
      await vi.advanceTimersByTimeAsync(15_000)
      hostReachable = true
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      attachLatestStream()
      await vi.advanceTimersByTimeAsync(50)

      // Why both: held input is one ordered stream; the stale part may be the Ctrl+C the rest relies on.
      expect(sentText()).toBe('STALE\ry\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops held input once a retry begun inside the grace latches again past it', async () => {
    vi.useFakeTimers()
    try {
      let hostReachable = false
      const transport = await connectThenLoseHost(() => hostReachable)
      expect(transport.sendInput('STALE\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 10_000)
      expect(transport.retryRecovery?.()).toBe(true)
      expect(transport.sendInput('y\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.sendInput('n\r', 'driving')).toBe(false)

      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
      attachLatestStream()
      await vi.advanceTimersByTimeAsync(50)
      transport.sendInput('ls\r', 'driving')
      await vi.advanceTimersByTimeAsync(50)

      expect(sentText()).toBe('ls\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the grace running when a web pane Reconnect fails again, so stale keys never run', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let hostReachable = false
      runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
        if (!hostReachable && request.method === 'session.tabs.activate') {
          throw unreachable()
        }
        return healthyRuntimeCall?.(request)
      })
      mockSubscribeUntilReachable(() => hostReachable)
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sendInput('git push -f\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 10_000)

      // Reconnect with the host still down: the replayed attach fails and latches again.
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sendInput('y\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')
      expect(transport.sendInput('n\r', 'driving')).toBe(false)

      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
      attachLatestStream()
      await vi.advanceTimersByTimeAsync(50)
      transport.sendInput('ls\r', 'driving')
      await vi.advanceTimersByTimeAsync(50)

      expect(sentText()).toBe('ls\r')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a web pane Reconnect whose attach stalls, so a late snapshot never releases held keys', async () => {
    vi.useFakeTimers()
    try {
      const healthyRuntimeCall = runtimeCall.getMockImplementation()
      let hostReachable = false
      runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
        if (!hostReachable && request.method === 'session.tabs.activate') {
          throw unreachable()
        }
        return healthyRuntimeCall?.(request)
      })
      mockSubscribeUntilReachable(() => hostReachable)
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-host-tab-1',
        leafId: 'pane:1'
      })
      transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.sendInput('git push -f\r', 'driving')).toBe(true)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS - 10_000)

      // The host answers the Reconnect, but the stream's initial snapshot never arrives.
      hostReachable = true
      expect(transport.retryRecovery?.()).toBe(true)
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(1))
      await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 1_000)
      expect(transport.getRecoveryState?.().phase).toBe('disconnected')

      await vi.advanceTimersByTimeAsync(60 * 60_000)
      attachLatestStream()
      await vi.advanceTimersByTimeAsync(50)

      expect(sentText()).toBe('')
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
