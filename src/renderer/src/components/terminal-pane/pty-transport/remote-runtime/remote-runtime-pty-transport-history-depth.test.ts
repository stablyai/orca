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

function acknowledgeSubscribe(streamId: number): void {
  subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
}

function dropLink(): void {
  subscriptionCallbacks?.onError?.({
    code: 'remote_runtime_unavailable',
    message: 'Remote runtime connection closed.'
  })
}

async function connectedTransport() {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  return transport
}

// N-02: only a pane with no local copy of the host's history asks for full depth.
describe('remote pane subscribe history depth', () => {
  it('a fresh pane (mount or app reopen) asks for full depth', async () => {
    const transport = await connectedTransport()
    expect(latestSubscribePayload().historyDepth).toBe('full')
    // Names this mount: a reopen right after a quit is a new mount, which the host still serves.
    expect(latestSubscribePayload().historyMountId).toMatch(/^[0-9a-f-]{36}$/)
    transport.destroy?.()
  })

  it('reconnects after the history landed fill the gap from the small cut', async () => {
    const transport = await connectedTransport()
    const first = latestSubscribePayload().streamId
    acknowledgeSubscribe(first)
    emitSnapshot(first, 'prompt$ ')
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    for (let drop = 2; drop <= 4; drop++) {
      dropLink()
      await vi.waitFor(() => expect(subscribeFrameCount()).toBe(drop))
      expect(latestSubscribePayload().historyDepth).toBeUndefined()
      const next = latestSubscribePayload().streamId
      acknowledgeSubscribe(next)
      emitSnapshot(next, 'prompt$ ')
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
    }
    transport.destroy?.()
  })

  it('asks again when the link dropped before the first history arrived', async () => {
    const transport = await connectedTransport()
    acknowledgeSubscribe(latestSubscribePayload().streamId)
    dropLink()
    await vi.waitFor(() => expect(subscribeFrameCount()).toBe(2))
    expect(latestSubscribePayload().historyDepth).toBe('full')
    transport.destroy?.()
  })
})
