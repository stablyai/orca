import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const appStore = vi.hoisted(() => ({
  getState: vi.fn(() => {
    throw new Error('These transport fixtures must not read app-store ownership')
  })
}))

vi.mock('@/store', () => ({ useAppStore: { getState: appStore.getState } }))

afterEach(() => {
  expect(appStore.getState).not.toHaveBeenCalled()
})

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
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

describe('remote runtime PTY stream end verdict', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('recovers a legacy bare end without reporting process exit', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
    const firstStreamId = latestSubscribePayload().streamId
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: firstStreamId }
    })

    expect(onExit).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(subscribedTerminalHandles()).toEqual(['terminal-1', 'terminal-1'])
    )
    expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
    transport.destroy?.()
  })

  it('retires the tab after an owning-host exit verdict', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1',
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
    const { streamId } = latestSubscribePayload()
    subscriptionCallbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId, verdict: 'exited' }
    })

    expect(onExit).toHaveBeenCalledWith(0)
    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(onPtyExit).toHaveBeenCalledWith('remote:env-1@@terminal-1')
    expect(runtimeSubscribe).toHaveBeenCalledTimes(1)
  })
  it('finishes independent reliable-end callbacks and captured close after the first effect throws', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('../../runtime/remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('env-1')
    const subscribe = multiplexer.subscribeTerminal.bind(multiplexer)
    const closed = vi.fn()
    const interception = vi
      .spyOn(multiplexer, 'subscribeTerminal')
      .mockImplementation(async (args) => {
        const stream = await subscribe(args)
        const close = stream.close
        stream.close = () => {
          close()
          closed()
          throw new Error('captured close failed')
        }
        return stream
      })
    const onExit = vi.fn(() => {
      throw new Error('first exit effect failed')
    })
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', { worktreeId: 'wt-1', onPtyExit })
    try {
      await transport.connect({ url: '', callbacks: { onExit, onDisconnect } })
      emitSnapshot(latestSubscribePayload().streamId, 'live A')
      const original = transport.getInputSource?.()
      expect(() =>
        subscriptionCallbacks?.onResponse({
          ok: true,
          result: {
            type: 'end',
            streamId: latestSubscribePayload().streamId,
            verdict: 'exited'
          }
        })
      ).toThrow('first exit effect failed')
      expect(onExit).toHaveBeenCalledOnce()
      expect(onDisconnect).toHaveBeenCalledOnce()
      expect(onPtyExit.mock.calls).toEqual([['remote:env-1@@terminal-1']])
      expect(closed).toHaveBeenCalledOnce()
      expect(original?.isCurrent()).toBe(false)
      expect(transport.getPtyId()).toBeNull()
      expect(transport.sendInput('refused-after-end', 'driving')).toBe(false)
      expect(inputFrameTexts()).toEqual([])
      expect(transport.getRecoveryState?.().phase).toBe('ended')
    } finally {
      interception.mockRestore()
      transport.destroy?.()
    }
  })
})
