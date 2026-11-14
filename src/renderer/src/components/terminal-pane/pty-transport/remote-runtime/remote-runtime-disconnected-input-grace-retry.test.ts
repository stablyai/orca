import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './recovery/remote-runtime-pty-recovery-limits'
import { REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS } from './input/remote-runtime-disconnected-input-grace'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

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

describe('disconnected input grace across retries', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
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
