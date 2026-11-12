import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      throw new Error('These transport fixtures must not read app-store ownership')
    }
  }
}))

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const {
  latestSubscribePayload,
  subscribedTerminalHandles,
  subscribeFrameCount,
  emitSnapshot,
  inputFrameTexts,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => resolvedHandle,
  setResolvedPaneHandle: (value) => {
    resolvedHandle = value
  }
})

beforeEach(resetRemoteRuntimeTransport)

// CJ9: on a healthy link this error used to go fatal and idle, dropping typed input.
describe('remote terminal whose host history is briefly unavailable', () => {
  it('reattaches the same terminal and delivers input typed meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const onExit = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        leafId: 'pane:2'
      })
      await transport.connect({ url: '', callbacks: { onExit } })
      const first = latestSubscribePayload().streamId
      callbacks?.onResponse({
        ok: true,
        result: { type: 'error', streamId: first, message: 'terminal_history_unavailable' }
      })
      callbacks?.onResponse({ ok: true, result: { type: 'end', streamId: first } })
      expect(transport.sendInput('typed\r', 'driving')).toBe(true)

      for (let waited = 0; waited < 30 && subscribeFrameCount() < 2; waited += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(subscribeFrameCount()).toBe(2)
      const { streamId } = latestSubscribePayload()
      callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
      emitSnapshot(streamId, 'prompt$ ')
      await vi.advanceTimersByTimeAsync(0)

      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
      await vi.waitFor(() => expect(inputFrameTexts().join('')).toBe('typed\r'))
      expect(onExit).not.toHaveBeenCalled()
      transport.destroy?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
