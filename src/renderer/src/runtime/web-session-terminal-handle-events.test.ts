import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  getWebSessionTerminalHandleSubscriberCountForTests,
  queueAcceptedWebSessionTerminalSnapshot,
  subscribeAcceptedWebSessionTerminalHandle
} from './web-session-terminal-handle-events'

function snapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  worktree = 'wt-1'
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

describe('accepted web-session terminal handle events', () => {
  it('notifies only the matching runtime/worktree/pane and releases the listener', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAcceptedWebSessionTerminalHandle(
      { environmentId: 'env-1', worktreeId: 'wt-1', hostTabId: 'tab-1', leafId: 'leaf-1' },
      listener
    )

    queueAcceptedWebSessionTerminalSnapshot(snapshot([]), 'env-2')
    queueAcceptedWebSessionTerminalSnapshot(snapshot([], 'wt-2'), 'env-1')
    queueAcceptedWebSessionTerminalSnapshot(
      snapshot([
        {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Claude Code',
          isActive: true,
          status: 'ready',
          terminal: 'terminal-replacement'
        }
      ]),
      'env-1'
    )
    await Promise.resolve()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      surfacePresent: true,
      terminalHandle: 'terminal-replacement'
    })
    expect(getWebSessionTerminalHandleSubscriberCountForTests()).toBe(1)
    unsubscribe()
    expect(getWebSessionTerminalHandleSubscriberCountForTests()).toBe(0)
  })

  it('distinguishes a pending handle from an explicitly removed surface', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAcceptedWebSessionTerminalHandle(
      { environmentId: 'env-1', worktreeId: 'wt-1', hostTabId: 'tab-1', leafId: 'leaf-1' },
      listener
    )

    queueAcceptedWebSessionTerminalSnapshot(
      snapshot([
        {
          type: 'terminal',
          id: 'tab-1::leaf-1',
          parentTabId: 'tab-1',
          leafId: 'leaf-1',
          title: 'Claude Code',
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      'env-1'
    )
    await Promise.resolve()
    queueAcceptedWebSessionTerminalSnapshot(snapshot([]), 'env-1')
    await Promise.resolve()

    expect(listener.mock.calls).toEqual([
      [{ surfacePresent: true, terminalHandle: null }],
      [{ surfacePresent: false, terminalHandle: null }]
    ])
    unsubscribe()
  })

  it('coalesces same-tick snapshots so only the newest accepted state is delivered', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAcceptedWebSessionTerminalHandle(
      { environmentId: 'env-1', worktreeId: 'wt-1', hostTabId: 'tab-1', leafId: 'leaf-1' },
      listener
    )
    const terminal = (handle: string): RuntimeMobileSessionTabsResult['tabs'][number] => ({
      type: 'terminal',
      id: 'tab-1::leaf-1',
      parentTabId: 'tab-1',
      leafId: 'leaf-1',
      title: 'Claude Code',
      isActive: true,
      status: 'ready',
      terminal: handle
    })

    queueAcceptedWebSessionTerminalSnapshot(snapshot([terminal('terminal-stale')]), 'env-1')
    queueAcceptedWebSessionTerminalSnapshot(snapshot([terminal('terminal-current')]), 'env-1')
    await Promise.resolve()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      surfacePresent: true,
      terminalHandle: 'terminal-current'
    })
    unsubscribe()
  })
})
