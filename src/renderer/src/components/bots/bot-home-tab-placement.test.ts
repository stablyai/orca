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
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../../runtime/native-chat/local-sessions/local-structured-session-owner'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
const bots = vi.hoisted(
  (): { hostId: string; chatSessionId: string | null; listeners: Set<() => void> } => ({
    hostId: 'local',
    chatSessionId: 'home',
    listeners: new Set<() => void>()
  })
)
vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [
    {
      id: 'bot-1',
      hostId: bots.hostId,
      folderWorkspaceId: 'bot-home',
      chatSessionId: bots.chatSessionId
    }
  ],
  readBotsEnabled: () => true,
  subscribeToBotChanges: (listener: () => void) => {
    bots.listeners.add(listener)
    return () => bots.listeners.delete(listener)
  }
}))

createTabsSliceMockApi()

const WT = 'folder:bot-home'

let store: ReturnType<typeof createTestStore>
let uninstall: () => void

function open(sessionId: string, targetGroupId?: string): Tab {
  return store.getState().createUnifiedTab(WT, 'agent-session', {
    id: `tab-${sessionId}`,
    entityId: sessionId,
    executionHostId: 'local',
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

function pinnedIds(): string[] {
  return (store.getState().unifiedTabsByWorktree[WT] ?? [])
    .filter((tab) => tab.isPinned)
    .map((tab) => tab.id)
}

function groupOf(tabId: string): string {
  return store.getState().unifiedTabsByWorktree[WT]!.find((tab) => tab.id === tabId)!.groupId
}

beforeEach(() => {
  bots.hostId = 'local'
  bots.chatSessionId = 'home'
  resetWebSessionTabsSyncTestState()
  store = createTestStore()
  store.setState({ workspaceSessionReady: true })
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
      executionHostId: 'local',
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

  it('preserves main ordering for a paired host without adding a Home pin', () => {
    bots.hostId = `runtime:${ENV}`
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
    expect(pinnedIds()).toEqual([])
  })

  it('unpins a side chat pinned before only Home could be, once the session restores, wherever it comes from', () => {
    store.setState({ workspaceSessionReady: false })
    open('home')
    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'tab-side-1',
      entityId: 'side-1',
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      label: 'side-1',
      isPinned: true
    })
    store.getState().createUnifiedTab(WT, 'browser', {
      id: 'tab-page',
      entityId: 'page',
      label: 'Docs',
      isPinned: true
    })
    // Restore is not done, so the window cannot know this pin is its own yet.
    expect(pinnedIds()).toEqual(['tab-side-1', 'tab-page'])

    store.setState({ workspaceSessionReady: true })
    expect(pinnedIds()).toEqual(['tab-home', 'tab-page'])
    expect(strips()).toEqual([['tab-home', 'tab-page', 'tab-side-1']])

    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'tab-side-2',
      entityId: 'side-2',
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      label: 'side-2',
      isPinned: true
    })
    expect(pinnedIds()).toEqual(['tab-home', 'tab-page'])
    expect(strips()[0]?.[0]).toBe('tab-home')
  })

  it('waits for a published Home before migrating pins, and never uses titles or another host as identity', () => {
    bots.chatSessionId = null
    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'owned-side',
      entityId: 'side',
      executionHostId: 'local',
      label: 'Home',
      isPinned: true
    })
    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'foreign-chat',
      entityId: 'home',
      executionHostId: `runtime:${ENV}`,
      label: 'Home',
      isPinned: true
    })
    bots.chatSessionId = 'home'
    bots.listeners.forEach((listener) => listener())
    expect(pinnedIds()).toEqual(['owned-side', 'foreign-chat'])

    open('home')
    expect(pinnedIds()).toEqual(['foreign-chat', 'tab-home'])
    expect(store.getState().getTab('owned-side')?.isPinned).toBe(false)
    expect(strips()[0]?.[0]).toBe('tab-home')
  })

  it('keeps the oldest published Home despite an older preview, without retiring its conversation', () => {
    uninstall()
    open('home')
    const duplicate = store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'newer-home',
      entityId: 'home',
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      label: 'Home'
    })
    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'preview-home',
      entityId: 'home',
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      label: 'Home',
      isPreview: true
    })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT]!.map((tab) => ({
          ...tab,
          createdAt: tab.id === 'preview-home' ? 0 : tab.id === 'tab-home' ? 1 : 2
        }))
      }
    }))
    uninstall = installBotHomeTabPlacement(store)
    expect(strips()).toEqual([['tab-home']])
    expect(store.getState().groupsByWorktree[WT]?.[0]?.activeTabId).toBe('tab-home')
    expect(store.getState().getTab(duplicate.id)).toBeNull()

    const snapshot = makeSnapshot(
      [
        {
          type: 'agent-session',
          id: 'agent-session:home',
          sessionId: 'home',
          agent: 'claude',
          title: 'Home',
          isActive: true
        }
      ],
      { worktree: WT }
    )
    store.setState((state) =>
      applyWebSessionTabsSnapshot(state, snapshot, LOCAL_STRUCTURED_SESSION_OWNER, NOW, {
        contentScope: 'agent-session'
      })
    )
    expect(strips()).toEqual([['tab-home']])
    expect(store.getState().getTab('tab-home')?.entityId).toBe('home')
  })

  it('keeps focus on Home when a focused duplicate in a split closes and Home moves to the top-left group', () => {
    const tab = (id: string, entityId: string, groupId: string, createdAt: number): Tab => ({
      id,
      entityId,
      executionHostId: 'local',
      groupId,
      worktreeId: WT,
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      label: id,
      customLabel: null,
      color: null,
      sortOrder: createdAt,
      createdAt
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
            tab('tab-side-1', 'side-1', 'left', 0),
            tab('tab-side-2', 'side-2', 'right', 0),
            tab('tab-home', 'home', 'right', 1),
            tab('dup-home', 'home', 'right', 2)
          ]
        },
        tabGroups: {
          [WT]: [
            { id: 'left', worktreeId: WT, activeTabId: 'tab-side-1', tabOrder: ['tab-side-1'] },
            {
              id: 'right',
              worktreeId: WT,
              activeTabId: 'dup-home',
              tabOrder: ['tab-side-2', 'tab-home', 'dup-home']
            }
          ]
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
    const state = store.getState()
    const activeGroupId = state.activeGroupIdByWorktree[WT]
    expect(activeGroupId).toBe(groupOf('tab-home'))
    expect(
      state.groupsByWorktree[WT]?.find((group) => group.id === activeGroupId)?.activeTabId
    ).toBe('tab-home')
  })

  it('keeps Home pinned across same-session inventory and transfers the pin on rotation', () => {
    open('home')
    const snapshot = makeSnapshot(
      [
        {
          type: 'agent-session',
          id: 'agent-session:home',
          sessionId: 'home',
          agent: 'claude',
          title: 'Cleared',
          isActive: true
        }
      ],
      { worktree: WT }
    )
    store.setState((state) =>
      applyWebSessionTabsSnapshot(state, snapshot, LOCAL_STRUCTURED_SESSION_OWNER, NOW, {
        contentScope: 'agent-session'
      })
    )
    expect(pinnedIds()).toEqual(['tab-home'])

    open('next-home')
    bots.chatSessionId = 'next-home'
    bots.listeners.forEach((listener) => listener())
    expect(strips()).toEqual([['tab-next-home', 'tab-home']])
    expect(pinnedIds()).toEqual(['tab-next-home'])
    expect(store.getState().getTab('tab-home')?.entityId).toBe('home')
  })

  it("leaves a paired host's pinned side chat to that host", () => {
    bots.hostId = `runtime:${ENV}`
    store.setState({ workspaceSessionReady: true })
    const snapshot = makeSnapshot(
      [
        {
          type: 'agent-session',
          id: 'agent-session:home',
          sessionId: 'home',
          agent: 'claude',
          title: 'Home',
          isActive: true
        },
        {
          type: 'agent-session',
          id: 'agent-session:side-1',
          sessionId: 'side-1',
          agent: 'claude',
          title: 'Side',
          isActive: false,
          isPinned: true
        }
      ],
      {
        worktree: WT,
        activeGroupId: 'host-group',
        activeTabId: 'agent-session:home',
        activeTabType: 'agent-session',
        tabGroups: [
          {
            id: 'host-group',
            activeTabId: 'agent-session:home',
            tabOrder: ['agent-session:home', 'agent-session:side-1']
          }
        ],
        tabGroupLayout: { type: 'leaf', groupId: 'host-group' }
      }
    )
    store.setState((state) => applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW))
    const side = (store.getState().unifiedTabsByWorktree[WT] ?? []).find(
      (tab) => tab.entityId === 'side-1'
    )
    expect(side?.isPinned).toBe(true)
  })
})
