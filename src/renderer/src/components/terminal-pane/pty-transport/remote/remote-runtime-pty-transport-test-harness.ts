import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createRuntimeStatusSubscriptions } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import type {
  RuntimeHostStatusSnapshot,
  RuntimeEnvironmentStatus
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  createTerminalStreamFixtures,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-stream-fixtures'

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

export function stubRuntimeHostStatusSubscriptions(): (
  snapshot: RuntimeHostStatusSnapshot
) => void {
  const hostStatuses = createStore(() => ({
    runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>()
  }))
  const runtimeStatusSubscriptions = createRuntimeStatusSubscriptions(hostStatuses)
  vi.doMock('@/store/slices/runtime-status/views/runtime-status-subscription-store', () => ({
    runtimeStatusSubscriptions
  }))
  return (snapshot) => {
    hostStatuses.setState({
      runtimeStatusByEnvironmentId: new Map(
        hostStatuses.getState().runtimeStatusByEnvironmentId
      ).set(snapshot.environmentId, {
        snapshot,
        status: snapshot.retired ? null : snapshot.status,
        checkedAt: snapshot.checkedAt
      })
    })
  }
}

export type RemoteRuntimeTransportMocks = {
  publishHostSnapshot: (snapshot: RuntimeHostStatusSnapshot) => void
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
  let publishHostSnapshot: (snapshot: RuntimeHostStatusSnapshot) => void = () => {
    throw new Error('Reset the runtime transport fixture before publishing host state')
  }
  const runtimeSubscribe = vi.fn()
  const refreshSessionTabsSnapshot = vi.fn(async () => {})
  const subscriptionSendBinary = vi.fn()
  const streamFixtures = createTerminalStreamFixtures({
    getCallbacks: bindings.getCallbacks,
    sendBinary: subscriptionSendBinary
  })

  function resetRemoteRuntimeTransport(): void {
    vi.resetModules()
    publishHostSnapshot = stubRuntimeHostStatusSubscriptions()
    vi.doUnmock(
      '../../../../runtime/hosted-terminals/streams/registry/remote-runtime-terminal-multiplexer-registry'
    )
    vi.doMock('@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
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
    publishHostSnapshot: (snapshot) => publishHostSnapshot(snapshot),
    runtimeCall,
    runtimeSubscribe,
    refreshSessionTabsSnapshot,
    subscriptionSendBinary,
    resetRemoteRuntimeTransport,
    ...streamFixtures
  }
}
