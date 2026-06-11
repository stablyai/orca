import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, WorkspaceSessionState } from '../../../../shared/types'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { buildHydratedTabState } from './tabs-hydration'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

const WT = 'repo1::/tmp/feature'
const GROUP = 'split-group-1'

function makeTab(id: string, sortOrder: number, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: id,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1,
    ...overrides
  }
}

function makeSession(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

describe('tab folder groups', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    const tabs = [makeTab('tab-1', 0), makeTab('tab-2', 1), makeTab('tab-3', 2)]
    const group: TabGroup = {
      id: GROUP,
      worktreeId: WT,
      activeTabId: 'tab-1',
      tabOrder: tabs.map((tab) => tab.id),
      recentTabIds: ['tab-1']
    }
    store.setState({
      unifiedTabsByWorktree: { [WT]: tabs },
      groupsByWorktree: { [WT]: [group] },
      activeGroupIdByWorktree: { [WT]: GROUP },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
      tabFolderGroupsByWorktree: {}
    })
  })

  it('creates, renames, recolors, and collapses a folder group', () => {
    const folder = store.getState().createTabFolderGroup(['tab-1', 'tab-2'], {
      color: '#22c55e',
      name: 'Feature'
    })

    expect(folder).not.toBeNull()
    expect(store.getState().tabFolderGroupsByWorktree[WT][0]).toMatchObject({
      name: 'Feature',
      color: '#22c55e',
      collapsed: false,
      tabOrder: ['tab-1', 'tab-2']
    })
    expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.folderGroupId)).toEqual([
      folder!.id,
      folder!.id,
      undefined
    ])

    store.getState().setTabFolderGroupName(folder!.id, 'Review')
    store.getState().setTabFolderGroupColor(folder!.id, '#ef4444')
    store.getState().setTabFolderGroupCollapsed(folder!.id, true)

    expect(store.getState().tabFolderGroupsByWorktree[WT][0]).toMatchObject({
      name: 'Review',
      color: '#ef4444',
      collapsed: true
    })
  })

  it('adds, removes, ungroups, and deletes empty folder groups', () => {
    const folder = store.getState().createTabFolderGroup(['tab-1'], { name: 'One' })!

    expect(store.getState().addTabsToFolderGroup(folder.id, ['tab-2'])).toBe(true)
    expect(store.getState().tabFolderGroupsByWorktree[WT][0].tabOrder).toEqual(['tab-1', 'tab-2'])

    expect(store.getState().moveTabOutOfFolderGroup('tab-1')).toBe(true)
    expect(store.getState().tabFolderGroupsByWorktree[WT][0].tabOrder).toEqual(['tab-2'])
    expect(store.getState().unifiedTabsByWorktree[WT][0].folderGroupId).toBeNull()

    store.getState().moveTabOutOfFolderGroup('tab-2')
    expect(store.getState().tabFolderGroupsByWorktree[WT]).toEqual([])

    const nextFolder = store.getState().createTabFolderGroup(['tab-3'], { name: 'Ungroup me' })!
    store.getState().ungroupTabFolderGroup(nextFolder.id)
    expect(store.getState().tabFolderGroupsByWorktree[WT]).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[WT][2].folderGroupId).toBeNull()
  })

  it('reorders tabs inside and between folder groups', () => {
    const firstFolder = store.getState().createTabFolderGroup(['tab-1', 'tab-2'], {
      name: 'First'
    })!
    const secondFolder = store.getState().createTabFolderGroup(['tab-3'], { name: 'Second' })!

    expect(store.getState().addTabsToFolderGroup(firstFolder.id, ['tab-1'], { index: 1 })).toBe(
      true
    )
    expect(store.getState().tabFolderGroupsByWorktree[WT][0].tabOrder).toEqual(['tab-2', 'tab-1'])

    expect(store.getState().addTabsToFolderGroup(secondFolder.id, ['tab-1'], { index: 0 })).toBe(
      true
    )
    expect(store.getState().tabFolderGroupsByWorktree[WT][0].tabOrder).toEqual(['tab-2'])
    expect(store.getState().tabFolderGroupsByWorktree[WT][1].tabOrder).toEqual(['tab-1', 'tab-3'])
    expect(store.getState().unifiedTabsByWorktree[WT][0].folderGroupId).toBe(secondFolder.id)
  })

  it('closes every tab in a folder group and removes the empty group', () => {
    const folder = store.getState().createTabFolderGroup(['tab-1', 'tab-2'], { name: 'Close me' })!

    expect(store.getState().closeTabsInFolderGroup(folder.id)).toEqual(['tab-1', 'tab-2'])
    expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['tab-3'])
    expect(store.getState().tabFolderGroupsByWorktree[WT]).toEqual([])
  })

  it('removes a closed tab from its folder group and deletes the empty group', () => {
    store.getState().createTabFolderGroup(['tab-1', 'tab-2'], {
      name: 'Closable'
    })

    expect(store.getState().closeUnifiedTab('tab-1')).toMatchObject({ closedTabId: 'tab-1' })
    expect(store.getState().tabFolderGroupsByWorktree[WT][0].tabOrder).toEqual(['tab-2'])

    expect(store.getState().closeUnifiedTab('tab-2')).toMatchObject({ closedTabId: 'tab-2' })
    expect(store.getState().tabFolderGroupsByWorktree[WT]).toEqual([])
    expect(store.getState().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['tab-3'])
  })

  it('round-trips folder groups through persisted session hydration', () => {
    const folder = store.getState().createTabFolderGroup(['tab-1', 'tab-2'], {
      color: '#a855f7',
      collapsed: true,
      name: 'Persisted'
    })!
    const state = store.getState()
    const persisted = buildPersistedUnifiedTabSessionData({
      activeGroupIdByWorktree: state.activeGroupIdByWorktree,
      groupsByWorktree: state.groupsByWorktree,
      layoutByWorktree: state.layoutByWorktree,
      tabFolderGroupsByWorktree: state.tabFolderGroupsByWorktree,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree
    })
    const hydrated = buildHydratedTabState(
      makeSession({
        ...persisted,
        tabsByWorktree: { [WT]: [] }
      }),
      new Set([WT])
    )

    expect(hydrated.tabFolderGroupsByWorktree[WT][0]).toMatchObject({
      id: folder.id,
      name: 'Persisted',
      color: '#a855f7',
      collapsed: true,
      tabOrder: ['tab-1', 'tab-2']
    })
    expect(
      hydrated.unifiedTabsByWorktree[WT].filter((tab) => tab.folderGroupId === folder.id)
    ).toHaveLength(2)
  })

  it('drops stale folder group members during hydration', () => {
    const hydrated = buildHydratedTabState(
      makeSession({
        unifiedTabs: { [WT]: [makeTab('tab-1', 0)] },
        tabGroups: {
          [WT]: [{ id: GROUP, worktreeId: WT, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
        },
        tabFolderGroups: {
          [WT]: [
            {
              id: 'folder-1',
              worktreeId: WT,
              splitGroupId: GROUP,
              name: 'Folder',
              color: '#3b82f6',
              collapsed: false,
              tabOrder: ['missing-tab'],
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }),
      new Set([WT])
    )

    expect(hydrated.tabFolderGroupsByWorktree[WT]).toBeUndefined()
    expect(hydrated.unifiedTabsByWorktree[WT][0].folderGroupId).toBeUndefined()
  })
})
