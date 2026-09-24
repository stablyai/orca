import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

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

function readySnapshot(snapshotVersion: number): unknown {
  return {
    worktree: 'id:wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'group-1',
    activeTabId: 'host-tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab-1::leaf-1',
        parentTabId: 'host-tab-1',
        leafId: 'leaf-1',
        title: 'Terminal 1',
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      }
    ]
  }
}

describe('remote runtime pty transport host absence evidence', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('does not report a live host terminal as closed when activation answers tab_not_found', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.activate') {
        // Why: a host still hydrating its worktree snapshot rejects with this before it republishes.
        return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      if (args.method === 'session.tabs.list') {
        return { ok: true, result: readySnapshot(2) }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'web-terminal-host-tab-1',
      leafId: 'leaf-1'
    })

    const onError = vi.fn()
    const result = await transport.connect({ url: '', callbacks: { onError } })

    expect(onError).not.toHaveBeenCalledWith('Remote terminal was closed.')
    expect(result).toEqual({
      id: 'remote:env-1@@terminal-1',
      replay: '',
      isReattach: true
    })
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.create' })
    )
  })

  // #21341: the host refuses a create hinting a pane it retired. That refusal is host evidence the
  // surface is gone, so the pane settles instead of showing the raw token, and nothing re-attempts.
  it('settles the pane without retrying when terminal.create answers tab_not_found', async () => {
    runtimeCall.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'terminal.create') {
        return { ok: false, error: { code: 'runtime_error', message: 'tab_not_found' } }
      }
      return { ok: true, result: {} }
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const onPtyExit = vi.fn()
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      onPtyExit
    })

    const onError = vi.fn()
    const onExit = vi.fn()
    const onDisconnect = vi.fn()
    const onRecoveryStateChange = vi.fn()
    const result = await transport.connect({
      url: '',
      callbacks: { onError, onExit, onDisconnect, onRecoveryStateChange }
    })

    expect(result).toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
    // The create never minted a pty id, so this settle is the pane's only exit signal.
    expect(onExit).toHaveBeenCalledWith(0)
    expect(onDisconnect).toHaveBeenCalled()
    expect(onRecoveryStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'ended' })
    )
    expect(
      runtimeCall.mock.calls.filter((call) => call[0]?.method === 'terminal.create')
    ).toHaveLength(1)
    expect(runtimeCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
  })
})
