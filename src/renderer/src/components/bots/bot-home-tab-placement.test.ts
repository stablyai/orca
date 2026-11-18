import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Tab,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { createTabsSliceMockApi } from '../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../store/testing/app-store-test-fixture'
import { applyWebSessionTabsSnapshot } from '../../runtime/web-session-tabs-sync/snapshots/snapshot-api'
import {
  ENV,
  NOW,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '../../runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import { installBotHomeTabPlacement } from './bot-home-tab-placement'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [{ id: 'bot-1', folderWorkspaceId: 'bot-home', chatSessionId: 'home' }],
  readBotsEnabled: () => true,
  subscribeToBotChanges: () => () => {}
}))

createTabsSliceMockApi()

const WT = 'folder:bot-home'

let store: ReturnType<typeof createTestStore>
let uninstall: () => void

function open(sessionId: string, targetGroupId?: string): Tab {
  return store.getState().createUnifiedTab(WT, 'agent-session', {
    id: `tab-${sessionId}`,
    entityId: sessionId,
    agentSessionAgent: 'claude',
    label: sessionId,
    ...(targetGroupId ? { targetGroupId } : {})
  })
}

/** Each group's tabs, left to right then top to bottom. */
function strips(): string[][] {
  const state = store.getState()
  const groups = new Map((state.groupsByWorktree[WT] ?? []).map((group) => [group.id, group]))
  const order: string[] = []
  const walk = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      order.push(node.groupId)
    } else {
      walk(node.first)
      walk(node.second)
    }
  }
  walk(state.layoutByWorktree[WT])
  const ids = order.length > 0 ? order : [...groups.keys()]
  return ids.map((id) => groups.get(id)?.tabOrder ?? [])
}

function groupOf(tabId: string): string {
  return store.getState().unifiedTabsByWorktree[WT]!.find((tab) => tab.id === tabId)!.groupId
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  store = createTestStore()
  uninstall = installBotHomeTabPlacement(store)
})

afterEach(() => uninstall())

describe('bot Home tab placement', () => {
  it('keeps Home first when a chat is dragged before it', () => {
    open('home')
    open('side-1')
    open('side-2')
    store
      .getState()
      .reorderUnifiedTabs(groupOf('tab-home'), ['tab-side-1', 'tab-home', 'tab-side-2'])
    expect(strips()).toEqual([['tab-home', 'tab-side-1', 'tab-side-2']])
  })

  it('follows a chat split off to the left of Home, and the emptied group closes', () => {
    open('home')
    open('side-1')
    store
      .getState()
      .dropUnifiedTab('tab-side-1', { groupId: groupOf('tab-home'), splitDirection: 'left' })
    expect(strips()).toEqual([['tab-home', 'tab-side-1']])
  })

  it('returns to the top-left group when a split before it fills and the old split closes', () => {
    open('home')
    open('side-1')
    const homeGroup = groupOf('tab-home')
    const landing = store.getState().createEmptySplitGroup(WT, homeGroup, 'left')!
    // An empty split is still choosing what to show, so Home waits.
    expect(strips()).toEqual([[], ['tab-home', 'tab-side-1']])
    open('side-2', landing)
    expect(strips()).toEqual([['tab-home', 'tab-side-2'], ['tab-side-1']])
    store.getState().closeUnifiedTab('tab-side-1')
    expect(strips()).toEqual([['tab-home', 'tab-side-2']])
  })

  it('puts Home back first in the top-left group when a saved layout restores', () => {
    const tab = (id: string, groupId: string, sortOrder: number): Tab => ({
      id,
      entityId: id.replace('tab-', ''),
      groupId,
      worktreeId: WT,
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      label: id,
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    })
    const group = (id: string, tabOrder: string[]): TabGroup => ({
      id,
      worktreeId: WT,
      activeTabId: tabOrder[0]!,
      tabOrder
    })
    store.getState().hydrateTabsSession(
      {
        activeRepoId: null,
        activeWorktreeId: WT,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: {
          [WT]: [
            tab('tab-side-1', 'left', 0),
            tab('tab-side-2', 'right', 0),
            tab('tab-home', 'right', 1)
          ]
        },
        tabGroups: {
          [WT]: [group('left', ['tab-side-1']), group('right', ['tab-side-2', 'tab-home'])]
        },
        tabGroupLayouts: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'left' },
            second: { type: 'leaf', groupId: 'right' }
          }
        },
        activeGroupIdByWorktree: { [WT]: 'right' }
      },
      { additionalValidWorkspaceKeys: [WT] }
    )
    expect(strips()).toEqual([['tab-home', 'tab-side-1'], ['tab-side-2']])
  })

  it('reopens first in the top-left group whichever group it opens in', () => {
    open('home')
    open('side-1')
    store
      .getState()
      .dropUnifiedTab('tab-side-1', { groupId: groupOf('tab-home'), splitDirection: 'right' })
    expect(strips()).toEqual([['tab-home'], ['tab-side-1']])
    store.getState().closeUnifiedTab('tab-home')
    expect(strips()).toEqual([['tab-side-1']])
    open('side-2')
    store.getState().createEmptySplitGroup(WT, groupOf('tab-side-1'), 'right')
    open('home', groupOf('tab-side-2'))
    expect(strips()[0]).toEqual(['tab-home', 'tab-side-1', 'tab-side-2'])
  })

  it('keeps Home first when the host window adds a page to its group', () => {
    open('home')
    open('side-1')
    // A pinned tab enters at the front of its group.
    store.getState().createUnifiedTab(WT, 'browser', {
      id: 'tab-page',
      entityId: 'page',
      label: 'Sign in',
      isPinned: true,
      targetGroupId: groupOf('tab-home')
    })
    expect(strips()).toEqual([['tab-home', 'tab-page', 'tab-side-1']])
  })

  it('keeps Home first when a paired client takes the host order with a page before Home', () => {
    const snapshot = makeSnapshot(
      [
        {
          type: 'browser',
          id: 'host-page',
          title: 'Sign in',
          browserWorkspaceId: 'page-workspace',
          browserPageId: 'page-1',
          url: 'https://example.com/',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:home',
          sessionId: 'home',
          agent: 'claude',
          title: 'Home',
          isActive: false
        }
      ],
      {
        worktree: WT,
        activeGroupId: 'host-group',
        activeTabId: 'host-page',
        activeTabType: 'browser',
        tabGroups: [
          {
            id: 'host-group',
            activeTabId: 'host-page',
            tabOrder: ['host-page', 'agent-session:home']
          }
        ],
        tabGroupLayout: { type: 'leaf', groupId: 'host-group' }
      }
    )
    store.setState((state) => applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW))
    const tabs = store.getState().unifiedTabsByWorktree[WT] ?? []
    const home = tabs.find((tab) => tab.entityId === 'home')!.id
    const page = tabs.find((tab) => tab.contentType === 'browser')!.id
    expect(strips()).toEqual([[home, page]])
    // The client now owns its order, so the next host publication leaves Home first.
    store.setState((state) =>
      applyWebSessionTabsSnapshot(state, { ...snapshot, snapshotVersion: 2 }, ENV, NOW + 1)
    )
    expect(strips()).toEqual([[home, page]])
  })
})
