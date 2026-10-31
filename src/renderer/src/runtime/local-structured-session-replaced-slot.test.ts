// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

// The window's half of a terminal→chat switch, through the real store: the host's frame carries the
// chat with the slot it replaced, and one pass puts the chat there and closes the terminal tab, as
// a replace rather than a user's close.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn(() => Promise.resolve())
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()
const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { applyStructuredSessionTabSnapshots } =
  await import('./local-structured-session-tabs-sync/snapshot-apply')
const { resetLocalStructuredSessionVersionForTests } =
  await import('./local-structured-session-tabs-sync/inventory-generation-fence')
const { resetWebSessionTabsSnapshotFreshnessForTests } =
  await import('./web-session-tabs-sync/tracking-lifecycle')

const WORKTREE = 'repo-1::/tmp/wt-switch'
const GROUP = 'group-1'

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

it.each([
  ['still held the selection', 'switched', GROUP, false],
  ['lost the selection to another tab', 'after', GROUP, false],
  // The user works in another split group: the group shows the chat, focus stays with the user.
  ['held the selection of a group the user left', 'switched', 'group-2', false],
  // [P1, S, P2 | U]: pinning must not move the chat to the end of the pinned group.
  ['sat in the middle of the pinned group', 'switched', GROUP, true]
])(
  'puts the chat in the replaced terminal’s pinned slot, closing it as a replace, when it %s',
  (_name, active, activeGroup, pinnedAfter) => {
    const terminal = (id: string, isPinned = false) =>
      makeUnifiedTab({
        id,
        entityId: id,
        groupId: GROUP,
        worktreeId: WORKTREE,
        contentType: 'terminal',
        isPinned
      })
    seedStore(store, {
      activeWorktreeId: WORKTREE,
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-switch' })]
      },
      tabsByWorktree: {
        [WORKTREE]: ['before', 'switched', 'pinned-after', 'after'].map((id) =>
          makeTab({ id, worktreeId: WORKTREE })
        )
      },
      unifiedTabsByWorktree: {
        [WORKTREE]: [
          terminal('before', true),
          terminal('switched', true),
          terminal('pinned-after', pinnedAfter),
          terminal('after')
        ]
      },
      groupsByWorktree: {
        [WORKTREE]: [
          makeTabGroup({
            id: GROUP,
            worktreeId: WORKTREE,
            activeTabId: active,
            tabOrder: ['before', 'switched', 'pinned-after', 'after'],
            recentTabIds: ['before', active]
          }),
          makeTabGroup({ id: 'group-2', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] })
        ]
      },
      layoutByWorktree: {
        [WORKTREE]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: GROUP },
          second: { type: 'leaf', groupId: 'group-2' }
        }
      },
      activeGroupIdByWorktree: { [WORKTREE]: activeGroup },
      openFiles: [],
      browserTabsByWorktree: {}
    })
    const reopenStack = store.getState().recentlyClosedTerminalTabsByWorktree
    const frame: RuntimeMobileSessionTabsResult = {
      worktree: WORKTREE,
      publicationEpoch: 'renderer:switch',
      snapshotVersion: 1,
      activeGroupId: GROUP,
      activeTabId: 'agent-session:session-1',
      activeTabType: 'agent-session',
      tabs: [
        {
          type: 'agent-session',
          id: 'agent-session:session-1',
          title: 'Codex',
          sessionId: 'session-1',
          agent: 'codex',
          isActive: true,
          replaces: { tabId: 'switched' }
        }
      ],
      tabGroups: [{ id: GROUP, activeTabId: null, tabOrder: ['agent-session:session-1'] }]
    }

    applyStructuredSessionTabSnapshots([frame])

    const state = store.getState()
    const chat = state.unifiedTabsByWorktree[WORKTREE]?.find(
      (tab) => tab.contentType === 'agent-session'
    )
    expect(state.groupsByWorktree[WORKTREE]?.[0]?.tabOrder).toEqual([
      'before',
      chat?.id,
      'pinned-after',
      'after'
    ])
    expect(chat?.isPinned).toBe(true)
    expect(state.tabsByWorktree[WORKTREE]?.some((tab) => tab.id === 'switched')).toBe(false)
    expect(state.recentlyClosedTerminalTabsByWorktree).toEqual(reopenStack)
    // The chat takes the selection only from a terminal that still held it.
    expect(state.groupsByWorktree[WORKTREE]?.[0]?.activeTabId).toBe(
      active === 'switched' ? chat?.id : 'after'
    )
    expect(state.activeGroupIdByWorktree[WORKTREE]).toBe(activeGroup)
  }
)

it('opens a chat with no replaced tab right after the tab its anchor names, keeping that tab', () => {
  // A History or uncaptured-pane switch: nothing was stopped, so the source tab stays.
  const terminal = (id: string) =>
    makeUnifiedTab({
      id,
      entityId: id,
      groupId: GROUP,
      worktreeId: WORKTREE,
      contentType: 'terminal'
    })
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-switch' })]
    },
    tabsByWorktree: {
      [WORKTREE]: ['source', 'later'].map((id) => makeTab({ id, worktreeId: WORKTREE }))
    },
    unifiedTabsByWorktree: { [WORKTREE]: [terminal('source'), terminal('later')] },
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({
          id: GROUP,
          worktreeId: WORKTREE,
          activeTabId: 'source',
          tabOrder: ['source', 'later'],
          recentTabIds: ['source']
        })
      ]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WORKTREE]: GROUP },
    openFiles: [],
    browserTabsByWorktree: {}
  })
  applyStructuredSessionTabSnapshots([
    {
      worktree: WORKTREE,
      publicationEpoch: 'renderer:history-switch',
      snapshotVersion: 1,
      activeGroupId: GROUP,
      activeTabId: 'agent-session:session-1',
      activeTabType: 'agent-session',
      tabs: [
        {
          type: 'agent-session',
          id: 'agent-session:session-1',
          title: 'Codex',
          sessionId: 'session-1',
          agent: 'codex',
          isActive: true,
          after: { tabId: 'source' }
        }
      ],
      tabGroups: [{ id: GROUP, activeTabId: null, tabOrder: ['agent-session:session-1'] }]
    }
  ])
  const state = store.getState()
  const chat = state.unifiedTabsByWorktree[WORKTREE]?.find(
    (tab) => tab.contentType === 'agent-session'
  )
  expect(state.groupsByWorktree[WORKTREE]?.[0]?.tabOrder).toEqual(['source', chat?.id, 'later'])
  expect(state.tabsByWorktree[WORKTREE]?.some((tab) => tab.id === 'source')).toBe(true)
})
