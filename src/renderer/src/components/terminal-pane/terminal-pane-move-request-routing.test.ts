// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import { moveTerminalPaneToNewTabForClient } from './terminal-pane-move-request-routing'
import { _resetTerminalPaneSplitRequestRoutingForTests } from './terminal-pane-split-request-routing'
import type { DetachTerminalPaneToNewTab } from './terminal-pane-tab-detach'
import { createTerminalTab } from './terminal-pane-tab-detach-fixture'

const storeState = vi.hoisted(() => ({
  groupsByWorktree: {
    'wt-1': [
      { id: 'group-1', tabOrder: ['unified-tab-1'] },
      { id: 'group-2', tabOrder: [] }
    ]
  },
  unifiedTabsByWorktree: {
    'wt-1': [
      { id: 'unified-tab-1', entityId: 'tab-1', contentType: 'terminal', groupId: 'group-1' }
    ]
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
const requestBackgroundTerminalWorktreeMount = vi.hoisted(() => vi.fn())
vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount
}))

const MOVED_LEAF = '22222222-2222-4222-8222-222222222222'

function mountTab(detachPaneToNewTab: DetachTerminalPaneToNewTab): () => void {
  const leafById = new Map<number, string>([
    [1, '11111111-1111-4111-8111-111111111111'],
    [2, MOVED_LEAF]
  ])
  const manager = {
    getNumericIdForLeaf: (leafId: string) =>
      [...leafById].find(([, id]) => id === leafId)?.[0] ?? null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move handler reads only getNumericIdForLeaf.
  const paneManager = manager as unknown as PaneManager
  return installTerminalPaneMountEvents({
    manager: paneManager,
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      managerRef: { current: paneManager },
      showPaneTitle: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn(),
      detachPaneToNewTab
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a pane move reads no pty deps.
    ptyDeps: {} as PtyConnectionDeps
  })
}

function moved(ptyId: string): ReturnType<DetachTerminalPaneToNewTab> {
  return Promise.resolve({ tab: createTerminalTab('client-tab', ptyId), leafId: MOVED_LEAF, ptyId })
}

const request = {
  worktreeId: 'wt-1',
  sourceTabId: 'tab-1',
  leafId: MOVED_LEAF,
  targetTabId: 'client-tab'
}

describe('a pane move a client asked this window for', () => {
  let unmount: (() => void) | null = null
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    unmount?.()
    unmount = null
    _resetTerminalPaneSplitRequestRoutingForTests()
    requestBackgroundTerminalWorktreeMount.mockReset()
    vi.useRealTimers()
  })

  it('moves the named pane into the tab the client drew, where the client dropped it', async () => {
    const detachPaneToNewTab = vi.fn<DetachTerminalPaneToNewTab>(() => moved('pty-2'))
    unmount = mountTab(detachPaneToNewTab)

    await expect(
      moveTerminalPaneToNewTabForClient({ ...request, targetGroupId: 'group-2', index: 0 })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-2' })
    expect(detachPaneToNewTab).toHaveBeenCalledWith(2, {
      groupId: 'group-2',
      index: 0,
      targetTabId: 'client-tab'
    })
  })

  it('puts the tab beside its source when this window has no such drop group', async () => {
    const detachPaneToNewTab = vi.fn<DetachTerminalPaneToNewTab>(() => moved('pty-2'))
    unmount = mountTab(detachPaneToNewTab)

    await moveTerminalPaneToNewTabForClient({ ...request, targetGroupId: 'gone', index: 3 })
    expect(detachPaneToNewTab).toHaveBeenCalledWith(2, {
      groupId: 'group-1',
      targetTabId: 'client-tab'
    })
  })

  it('mounts a parked source tab, then moves its pane', async () => {
    const detachPaneToNewTab = vi.fn<DetachTerminalPaneToNewTab>(() => moved('pty-2'))
    const answer = moveTerminalPaneToNewTabForClient(request)
    expect(requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-1']
    })
    unmount = mountTab(detachPaneToNewTab)

    await expect(answer).resolves.toEqual({ status: 'moved', ptyId: 'pty-2' })
  })

  it('refuses when the source tab does not mount, so the client puts the pane back', async () => {
    const answer = moveTerminalPaneToNewTabForClient(request)
    await vi.runAllTimersAsync()

    await expect(answer).resolves.toEqual({ status: 'refused', reason: 'pane_unavailable' })
  })
})
