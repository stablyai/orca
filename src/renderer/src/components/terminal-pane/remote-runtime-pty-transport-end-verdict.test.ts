import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeSubscribe,
  latestSubscribePayload,
  subscribedTerminalHandles,
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
  it('retires a remote workspace terminal after an owning-host exit verdict', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
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
})
