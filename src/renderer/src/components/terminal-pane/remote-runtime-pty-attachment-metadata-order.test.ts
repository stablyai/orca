import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-terminal-contracts'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-current'
const mocks = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (next) => {
    callbacks = next
  },
  getResolvedPaneHandle: () => resolvedHandle,
  setResolvedPaneHandle: (next) => {
    resolvedHandle = next
  }
})
const currentMetadata = {
  incarnationId: 'inc-current',
  executionHostId: 'runtime:env-1',
  hostPlatform: 'linux'
} as const
const obsoleteMetadata = {
  incarnationId: 'inc-obsolete',
  executionHostId: 'ssh:obsolete-host',
  hostPlatform: 'win32'
} as const

function inventoryFor(
  terminal: string,
  metadata: Pick<RuntimeTerminalResolvePane, 'incarnationId' | 'executionHostId' | 'hostPlatform'>
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'tab-1::pane:1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab-1::pane:1',
        parentTabId: 'tab-1',
        leafId: 'pane:1',
        title: 'Terminal',
        isActive: true,
        status: 'ready',
        terminal,
        ...metadata
      }
    ]
  }
}

describe('host mirror attachment metadata ordering', () => {
  beforeEach(() => mocks.resetRemoteRuntimeTransport())

  it.each(['activation', 'inventory'] as const)(
    'rejects obsolete %s metadata after a newer attachment completes',
    async (source) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const events = await import('../../runtime/web-session-terminal-handle-events')
      const pending = createDeferred<{ ok: boolean; result: RuntimeMobileSessionTabsResult }>()
      const currentInventory = inventoryFor('terminal-current', currentMetadata)
      let activations = 0
      let inventories = 0
      mocks.runtimeCall.mockImplementation((args: { method: string }) => {
        if (args.method === 'session.tabs.activate') {
          activations += 1
          if (activations === 1) {
            return source === 'activation'
              ? pending.promise
              : Promise.resolve({ ok: true, result: { ...currentInventory, tabs: [] } })
          }
          return Promise.resolve({ ok: true, result: currentInventory })
        }
        if (args.method === 'session.tabs.list') {
          inventories += 1
          return pending.promise
        }
        if (args.method === 'terminal.resolvePane') {
          return Promise.resolve({
            ok: true,
            result: {
              terminal: {
                handle: 'terminal-current',
                tabId: 'tab-1',
                leafId: 'pane:1',
                worktreeId: 'wt-1',
                ...currentMetadata
              }
            }
          })
        }
        return Promise.resolve({ ok: true, result: {} })
      })
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyRebind
      })
      const attach = () =>
        transport.attach({
          existingPtyId: 'remote:env-1@@terminal-current',
          callbacks: {}
        })
      try {
        attach()
        await vi.waitFor(() => expect(source === 'activation' ? activations : inventories).toBe(1))
        attach()
        await vi.waitFor(() => expect(mocks.subscriptionSendBinary).toHaveBeenCalled())
        mocks.emitSnapshot(mocks.latestSubscribePayload().streamId, 'current image')
        expect(onPtyRebind).toHaveBeenCalledExactlyOnceWith(
          'remote:env-1@@terminal-current',
          'remote:env-1@@terminal-current',
          'inc-current'
        )
        onPtyRebind.mockClear()
        pending.resolve({ ok: true, result: inventoryFor('terminal-obsolete', obsoleteMetadata) })
        await flushAsyncTicks(8)
        expect(transport.getPtyId()).toBe('remote:env-1@@terminal-current')
        expect.soft(transport.getExecutionHostId?.()).toBe('runtime:env-1')
        expect.soft(transport.getRemotePlatform?.()).toBe('linux')

        // Keep inventory recovery pending so the next accepted publication exposes incarnation drift.
        mocks.runtimeCall.mockImplementation(() => new Promise(() => {}))
        callbacks?.onClose?.()
        await vi.waitFor(() =>
          expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
        )
        const subscriptionCount = mocks.subscribedTerminalHandles().length
        events.queueAcceptedWebSessionTerminalSnapshot(currentInventory, 'env-1')
        await flushAsyncTicks(8)
        expect(onPtyRebind).not.toHaveBeenCalled()
        expect(mocks.subscribedTerminalHandles()).toHaveLength(subscriptionCount)
        expect(transport.getExecutionHostId?.()).toBe('runtime:env-1')
        expect(transport.getRemotePlatform?.()).toBe('linux')
      } finally {
        transport.destroy?.()
      }
    }
  )
})
