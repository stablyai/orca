import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store/index', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { PtyTransport } from '../pty-transport-types'
import { createRemoteRuntimeTransportMocks } from '../remote/remote-runtime-pty-transport-test-harness'
import type { MultiplexSubscriptionCallbacks } from '../remote/remote-runtime-pty-transport-stream-fixtures'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  subscriptionSendBinary,
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

beforeEach(() => {
  resetRemoteRuntimeTransport()
  runtimeSubscribe.mockImplementation(
    async (_args: unknown, callbacks: NonNullable<typeof subscriptionCallbacks>) => {
      subscriptionCallbacks = callbacks
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
    }
  )
})

/** Viewport frames in send order, so a test can check a claim precedes typing. */
function viewportAndInputFrames(): string[] {
  return subscriptionSendBinary.mock.calls.flatMap(([bytes]) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (frame?.opcode === TerminalStreamOpcode.Input) {
      return ['input']
    }
    if (
      frame?.opcode === TerminalStreamOpcode.ClaimViewport ||
      frame?.opcode === TerminalStreamOpcode.Resize
    ) {
      const size = decodeTerminalStreamJson<{ cols: number; rows: number }>(frame.payload)
      const kind = frame.opcode === TerminalStreamOpcode.ClaimViewport ? 'claim' : 'resize'
      return [`${kind} ${size?.cols}x${size?.rows}`]
    }
    return []
  })
}

function acknowledgeSubscribe(streamId: number): void {
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
}

/** Connects, drops the link, and waits for the recovery resubscribe to go out. */
async function recoveringTransport(duringOutage?: (transport: PtyTransport) => void) {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const first = latestSubscribePayload().streamId
  acknowledgeSubscribe(first)
  emitSnapshot(first, 'prompt$ ')
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
  subscriptionCallbacks?.onError?.({
    code: 'remote_runtime_unavailable',
    message: 'Remote runtime connection closed.'
  })
  duringOutage?.(transport)
  await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
  return { transport, streamId: latestSubscribePayload().streamId }
}

describe('remote recovery input at the subscribed ack', () => {
  it('does not let a resize batched before a second outage overwrite the replayed claim', async () => {
    const { transport, streamId } = await recoveringTransport()
    acknowledgeSubscribe(streamId)
    expect(transport.resize(90, 25)).toBe(true)
    subscriptionCallbacks?.onError?.({
      code: 'remote_runtime_unavailable',
      message: 'Remote runtime connection closed.'
    })
    expect(transport.claimViewport?.(120, 40)).toBe(true)
    // Reconnect inside the 33ms viewport batch window.
    for (let turn = 0; turn < 50 && subscribeFrameCount() < 3; turn += 1) {
      await Promise.resolve()
    }
    expect(subscribeFrameCount()).toBe(3)
    const next = latestSubscribePayload().streamId
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(next)
    // Outlasts the viewport batch window, so a surviving stale batch would have flushed.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(viewportAndInputFrames()).toEqual(['claim 120x40', 'resize 120x40'])
    transport.destroy?.()
  })

  it('keeps a deferred claim for the next stream when its replay fails to write', async () => {
    const { transport, streamId } = await recoveringTransport((outage) => {
      expect(outage.claimViewport?.(100, 30)).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    subscriptionSendBinary.mockImplementationOnce((bytes) => {
      if (decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.ClaimViewport) {
        throw new Error('socket closed')
      }
    })
    acknowledgeSubscribe(streamId)
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(3))
    const next = latestSubscribePayload().streamId
    subscriptionSendBinary.mockClear()
    acknowledgeSubscribe(next)
    await vi.waitFor(() =>
      expect(viewportAndInputFrames()).toEqual(['claim 100x30', 'resize 100x30'])
    )
    transport.destroy?.()
  })
})
