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
})
