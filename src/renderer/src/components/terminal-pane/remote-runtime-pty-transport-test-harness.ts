import { vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  createTerminalStreamFixtures,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-stream-fixtures'

export type { MultiplexSubscriptionCallbacks }

/**
 * Test files keep `subscriptionCallbacks`/`resolvedPaneHandle` as their own bindings so specs can
 * reassign them; the harness reaches them through these accessors.
 */
type RemoteRuntimeTransportBindings = {
  getCallbacks: () => MultiplexSubscriptionCallbacks
  setCallbacks: (callbacks: MultiplexSubscriptionCallbacks) => void
  getResolvedPaneHandle: () => string
  setResolvedPaneHandle: (handle: string) => void
}

export function readyHostSessionInventoryResponse(
  terminal: string,
  hostTabId = 'host-tab-1'
): unknown {
  return {
    ok: true,
    result: {
      worktree: 'wt-1',
      publicationEpoch: 'epoch-ready',
      snapshotVersion: 2,
      activeGroupId: null,
      activeTabId: `${hostTabId}::pane:1`,
      activeTabType: 'terminal',
      tabs: [
        {
          type: 'terminal',
          id: `${hostTabId}::pane:1`,
          parentTabId: hostTabId,
          leafId: 'pane:1',
          title: 'Terminal',
          isActive: true,
          status: 'ready',
          terminal
        }
      ]
    }
  }
}

export type RemoteRuntimeTransportMocks = {
  // Why: specs re-implement these with their own request/callback shapes, so keep the loose spy type.
  runtimeCall: Mock
  runtimeSubscribe: Mock
  refreshSessionTabsSnapshot: Mock<() => Promise<void>>
  subscriptionSendBinary: Mock<(bytes: Uint8Array<ArrayBufferLike>) => void>
  /** Re-arms the module registry, window stubs and default RPC implementations between specs. */
  resetRemoteRuntimeTransport: () => void
} & ReturnType<typeof createTerminalStreamFixtures>

/** Runtime-environment RPC/subscribe doubles shared by the remote runtime PTY transport specs. */
export function createRemoteRuntimeTransportMocks(
  bindings: RemoteRuntimeTransportBindings
): RemoteRuntimeTransportMocks {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  const streamFixtures = createTerminalStreamFixtures({
    getCallbacks: bindings.getCallbacks,
    sendBinary: subscriptionSendBinary
  })

  function resetRemoteRuntimeTransport(): void {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.doMock('@/runtime/web-runtime-session', () => ({
      refreshWebRuntimeSessionTabsSnapshot: refreshSessionTabsSnapshot
    }))
    vi.clearAllMocks()
    bindings.setCallbacks(null)
    bindings.setResolvedPaneHandle('terminal-1')
    subscriptionSendBinary.mockReset()
    refreshSessionTabsSnapshot.mockClear()
    runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'session.tabs.activate') {
        const params = request.params as { tabId: string; leafId?: string }
        const resolvedLeafId = params.leafId ?? 'pane:1'
        return {
          ok: true,
          result: {
            worktree: 'id:wt-1',
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1,
            activeGroupId: 'group-1',
            activeTabId: `${params.tabId}::${resolvedLeafId}`,
            activeTabType: 'terminal',
            tabs: [
              {
                type: 'terminal',
                id: `${params.tabId}::${resolvedLeafId}`,
                parentTabId: params.tabId,
                leafId: resolvedLeafId,
                title: 'Terminal',
                isActive: true,
                status: 'ready',
                terminal: bindings.getResolvedPaneHandle()
              }
            ]
          }
        }
      }
      if (request.method === 'terminal.resolvePane') {
        const params = request.params as { paneKey: string; worktreeId: string }
        const separator = params.paneKey.indexOf(':')
        const handle = bindings.getResolvedPaneHandle()
        return {
          ok: true,
          result: {
            terminal: {
              handle,
              tabId: params.paneKey.slice(0, separator),
              leafId: params.paneKey.slice(separator + 1),
              worktreeId: params.worktreeId
            }
          }
        }
      }
      return { ok: true, result: { terminal: { handle: 'terminal-1' } } }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: MultiplexSubscriptionCallbacks) => {
        bindings.setCallbacks(callbacks)
        queueMicrotask(streamFixtures.emitMultiplexReady)
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
  }

  return {
    runtimeCall,
    runtimeSubscribe,
    refreshSessionTabsSnapshot,
    subscriptionSendBinary,
    resetRemoteRuntimeTransport,
    ...streamFixtures
  }
}
