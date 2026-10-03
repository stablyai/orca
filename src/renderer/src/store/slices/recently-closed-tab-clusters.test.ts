import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WT = 'repo1::/path/wt1'
const kinds = ['terminal', 'browser', 'editor'] as const

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      worktrees: {
        list: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        updateMeta: vi.fn().mockResolvedValue({})
      },
      pty: { kill: vi.fn().mockResolvedValue(undefined) },
      runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

function closeClusteredMember(kind: (typeof kinds)[number]) {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  const anchor = store.getState().createTab(WT)
  const entityId =
    kind === 'terminal'
      ? store.getState().createTab(WT).id
      : kind === 'browser'
        ? store.getState().createBrowserTab(WT, 'https://example.com', { title: 'Docs' }).id
        : store.getState().openFile(
            {
              filePath: '/path/wt1/readme.md',
              relativePath: 'readme.md',
              worktreeId: WT,
              language: 'markdown',
              mode: 'edit'
            },
            { preview: false, suppressActiveRuntimeFallback: true }
          )
  const outside = store.getState().createTab(WT)
  const pane = store.getState().groupsByWorktree[WT]?.[0]
  const tabs = store.getState().unifiedTabsByWorktree[WT] ?? []
  const anchorTab = tabs.find((tab) => tab.entityId === anchor.id)
  const memberTab = tabs.find((tab) => tab.entityId === entityId && tab.contentType === kind)
  const outsideTab = tabs.find((tab) => tab.entityId === outside.id)
  if (!pane || !anchorTab || !memberTab || !outsideTab) {
    throw new Error('Expected all fixture tabs in one pane')
  }
  const clusterId = store.getState().createTabCluster(pane.id, [anchorTab.id, memberTab.id], {
    name: 'Work',
    color: 'blue'
  })
  if (!clusterId) {
    throw new Error('Expected cluster creation')
  }
  store.getState().setTabClusterCollapsed(pane.id, clusterId, true)
  if (kind === 'terminal') {
    store.getState().closeTab(entityId)
  } else if (kind === 'browser') {
    store.getState().closeBrowserTab(entityId)
  } else {
    store.getState().closeFile(entityId)
  }

  const state = store.getState()
  const position =
    kind === 'terminal'
      ? state.recentlyClosedTerminalTabsByWorktree[WT]?.[0]?.position
      : kind === 'browser'
        ? state.recentlyClosedBrowserTabsByWorktree[WT]?.[0]?.position
        : state.recentlyClosedEditorTabsByWorktree[WT]?.[0]?.position
  return {
    store,
    clusterId,
    groupId: pane.id,
    anchorTabId: anchorTab.id,
    outsideTabId: outsideTab.id,
    position
  }
}

describe('reopening closed cluster members', () => {
  it.each(kinds)('%s rejoins a surviving collapsed cluster at its captured position', (kind) => {
    const { store, clusterId, groupId, anchorTabId, outsideTabId, position } =
      closeClusteredMember(kind)
    expect(position).toMatchObject({ groupId, groupIndex: 1, clusterId })
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    const restored = store.getState().getActiveTab(WT)
    if (!restored) {
      throw new Error('Expected an activated reopened tab')
    }
    expect(restored.contentType).toBe(kind)
    const pane = store.getState().groupsByWorktree[WT].find((group) => group.id === groupId)
    expect(pane?.tabOrder).toEqual([anchorTabId, restored.id, outsideTabId])
    expect(pane?.tabClusters?.[0]).toMatchObject({
      id: clusterId,
      name: 'Work',
      color: 'blue',
      collapsed: true,
      tabIds: [anchorTabId, restored.id]
    })
  })

  it('rejoins a surviving cluster that moved away from the captured index', () => {
    const { store, clusterId, groupId, anchorTabId, outsideTabId } =
      closeClusteredMember('terminal')
    // Why: same-pane group drags commit through moveTabsInStrip.
    store.getState().moveTabsInStrip(groupId, [anchorTabId], { index: 1, clusterId })
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    const restored = store.getState().getActiveTab(WT)
    if (!restored) {
      throw new Error('Expected an activated reopened tab')
    }
    const pane = store.getState().groupsByWorktree[WT].find((group) => group.id === groupId)
    expect(pane?.tabOrder).toEqual([outsideTabId, restored.id, anchorTabId])
    expect(pane?.tabClusters?.[0].tabIds).toEqual([restored.id, anchorTabId])
  })

  it.each(kinds)('%s stays ungrouped when its captured cluster was removed', (kind) => {
    const { store, clusterId, groupId, anchorTabId, outsideTabId } = closeClusteredMember(kind)
    store.getState().ungroupTabCluster(groupId, clusterId)
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    const restored = store.getState().getActiveTab(WT)
    if (!restored) {
      throw new Error('Expected an activated reopened tab')
    }
    const pane = store.getState().groupsByWorktree[WT].find((group) => group.id === groupId)
    expect(pane?.tabOrder).toEqual([anchorTabId, restored.id, outsideTabId])
    expect(pane?.tabClusters).toBeUndefined()
  })
})
