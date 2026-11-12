import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamText
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'
import './recovery/remote-runtime-pty-recovery-state'

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
  runtimeSubscribe,
  subscriptionSendBinary,
  latestSubscribePayload,
  emitOutput,
  emitSnapshot,
  latestFrameForOpcode,
  inputFrameTexts,
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

describe('createRemoteRuntimePtyTransport', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('recovers repeated partitions without changing PTY identity and delivers detached input once', async () => {
    const callbacksByEpoch: NonNullable<typeof subscriptionCallbacks>[] = []
    const unsubscribeByEpoch: ReturnType<typeof vi.fn>[] = []
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
        callbacksByEpoch.push(callbacks)
        subscriptionCallbacks = callbacks
        const unsubscribe = vi.fn()
        unsubscribeByEpoch.push(unsubscribe)
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return { unsubscribe, sendBinary: subscriptionSendBinary }
      }
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onData = vi.fn()
    const onError = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })

    await transport.connect({ url: '', callbacks: { onData, onError } })
    const ptyId = transport.getPtyId()

    for (let cycle = 0; cycle < 10; cycle += 1) {
      callbacksByEpoch.at(-1)?.onError?.({
        code: 'remote_runtime_unavailable',
        message: 'Remote runtime connection closed.'
      })

      expect(transport.isConnected()).toBe(false)
      // Why: keys typed while the same PTY recovers are held and delivered once it rebinds (#25784).
      expect(transport.sendInput(`detached-${cycle}`, 'driving')).toBe(true)
      expect(unsubscribeByEpoch[cycle]).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(cycle + 2))
      await vi.waitFor(() => expect(latestSubscribePayload().terminal).toBe('terminal-1'))
      const { streamId } = latestSubscribePayload()
      expect(transport.isConnected()).toBe(false)
      emitSnapshot(streamId, `snapshot-${cycle}`)
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
      emitOutput(streamId, `output-${cycle}`)
      expect(transport.sendInputImmediate(`input-${cycle}`)).toBe(true)

      expect(transport.getPtyId()).toBe(ptyId)
      expect(inputFrameTexts().filter((text) => text.includes(`detached-${cycle}`))).toHaveLength(1)
      expect(onData).toHaveBeenCalledWith(`output-${cycle}`, expect.any(Object))
      expect(
        decodeTerminalStreamText(
          latestFrameForOpcode(TerminalStreamOpcode.Input)?.payload ?? new Uint8Array()
        )
      ).toBe(`input-${cycle}`)
      expect(callbacksByEpoch).toHaveLength(cycle + 2)
    }

    expect(onError).not.toHaveBeenCalled()
    expect(runtimeSubscribe).toHaveBeenCalledTimes(11)
    transport.destroy?.()
    expect(unsubscribeByEpoch.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(
      true
    )
  })
})
