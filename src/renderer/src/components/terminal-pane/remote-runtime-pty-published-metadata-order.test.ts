import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
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

function snapshotForHandle(terminal: string): RuntimeMobileSessionTabsResult {
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
        terminal
      }
    ]
  }
}

function metadataForHandle(handle: string) {
  return {
    ok: true,
    result: {
      terminal: {
        handle,
        tabId: 'tab-1',
        leafId: 'pane:1',
        worktreeId: 'wt-1',
        incarnationId: `inc-${handle}`
      }
    }
  }
}

describe('accepted remote terminal metadata ordering', () => {
  beforeEach(() => mocks.resetRemoteRuntimeTransport())

  it.each(['terminal-3', 'terminal-1'])(
    'does not let an older lookup supersede a newer publication of %s',
    async (newerHandle) => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const events = await import('../../runtime/web-session-terminal-handle-events')
      const onPtyRebind = vi.fn()
      const transport = createRemoteRuntimePtyTransport('env-1', {
        worktreeId: 'wt-1',
        tabId: 'web-terminal-tab-1',
        leafId: 'pane:1',
        onPtyRebind
      })
      try {
        transport.attach({ existingPtyId: 'remote:env-1@@terminal-1', callbacks: {} })
        await vi.waitFor(() => expect(mocks.subscriptionSendBinary).toHaveBeenCalled())
        mocks.emitSnapshot(mocks.latestSubscribePayload().streamId, 'initial')
        const oldLookup = createDeferred<ReturnType<typeof metadataForHandle>>()
        const newLookup = createDeferred<ReturnType<typeof metadataForHandle>>()
        let lookupCount = 0
        mocks.runtimeCall.mockImplementation((args: { method: string }) => {
          if (args.method === 'terminal.resolvePane') {
            lookupCount += 1
            return lookupCount === 1 ? oldLookup.promise : newLookup.promise
          }
          // Keep the inventory recovery pending so accepted publications own the race.
          return new Promise(() => {})
        })
        callbacks?.onClose?.()
        await vi.waitFor(() =>
          expect(events.getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
        )
        onPtyRebind.mockClear()
        events.queueAcceptedWebSessionTerminalSnapshot(snapshotForHandle('terminal-2'), 'env-1')
        await vi.waitFor(() => expect(lookupCount).toBe(1))
        events.queueAcceptedWebSessionTerminalSnapshot(snapshotForHandle(newerHandle), 'env-1')
        await flushAsyncTicks(4)
        expect(lookupCount).toBe(newerHandle === 'terminal-1' ? 1 : 2)
        // The old lookup finishes first while the newer publication already owns recovery.
        oldLookup.resolve(metadataForHandle('terminal-2'))
        await flushAsyncTicks(8)
        expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1')
        expect(onPtyRebind).not.toHaveBeenCalled()
        if (newerHandle !== 'terminal-1') {
          newLookup.resolve(metadataForHandle(newerHandle))
          await vi.waitFor(() => expect(transport.getPtyId()).toBe(`remote:env-1@@${newerHandle}`))
          expect(onPtyRebind).toHaveBeenCalledExactlyOnceWith(
            `remote:env-1@@${newerHandle}`,
            'remote:env-1@@terminal-1',
            `inc-${newerHandle}`
          )
        }
      } finally {
        transport.destroy?.()
      }
    }
  )
})
