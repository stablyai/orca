// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'

// Main names the window's tabs in a phone's or paired client's move by the rows the window
// published: a tab a switch left holding a terminal is named by that terminal's id.

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
const api = createTabsSliceMockApi()
const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

let move: ((move: RuntimeMobileSessionTabMove & { worktreeId: string }) => void) | undefined
Object.assign(api, {
  ui: {
    onCloseSessionTab: () => () => {},
    onSessionTabCloseRequest: () => () => {},
    onMoveSessionTab: (handler: typeof move) => {
      move = handler
      return () => {}
    }
  }
})
const { registerSessionTabIpcBridge } = await import('./session-tab-ipc-bridge')

const WORKTREE = 'repo-1::/tmp/wt-switch'

it('moves a switched tab by its terminal’s id, and nothing by an id it no longer publishes', () => {
  const tab = (id: string, entityId: string) =>
    makeUnifiedTab({ id, entityId, groupId: 'g1', worktreeId: WORKTREE, contentType: 'terminal' })
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-switch' })]
    },
    tabsByWorktree: {
      [WORKTREE]: [
        makeTab({ id: 'E', worktreeId: WORKTREE }),
        makeTab({ id: 'other', worktreeId: WORKTREE })
      ]
    },
    // T held a chat; a switch left terminal E in it under T's own id.
    unifiedTabsByWorktree: { [WORKTREE]: [tab('T', 'E'), tab('other', 'other')] },
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({
          id: 'g1',
          worktreeId: WORKTREE,
          activeTabId: 'T',
          tabOrder: ['T', 'other']
        }),
        makeTabGroup({ id: 'g2', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] })
      ]
    },
    layoutByWorktree: {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: { type: 'leaf', groupId: 'g2' }
      }
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'g1' },
    openFiles: [],
    browserTabsByWorktree: {}
  })
  registerSessionTabIpcBridge([])
  const groupOf = (id: string) =>
    store.getState().unifiedTabsByWorktree[WORKTREE]?.find((entry) => entry.id === id)?.groupId
  const order = (groupId: string) =>
    store.getState().groupsByWorktree[WORKTREE]?.find((group) => group.id === groupId)?.tabOrder

  move!({
    worktreeId: WORKTREE,
    tabId: 'E',
    targetGroupId: 'g1',
    kind: 'reorder',
    tabOrder: ['other', 'E']
  })
  expect(order('g1')).toEqual(['other', 'T'])
  // Late rows naming what T held before the switch (its chat, or the tab itself) move nothing.
  for (const stale of ['agent-session:session-1', 'T']) {
    move!({
      worktreeId: WORKTREE,
      tabId: stale,
      targetGroupId: 'g2',
      kind: 'move-to-group',
      index: 0
    })
    expect(groupOf('T')).toBe('g1')
  }
  move!({ worktreeId: WORKTREE, tabId: 'E', targetGroupId: 'g2', kind: 'move-to-group', index: 0 })
  expect(groupOf('T')).toBe('g2')
})

// A chat reopened under its own host row publishes only that row; its retired session row is a
// History address (typed activation), never one a move can name.
it('moves a reopened chat by the row it publishes, and nothing by its retired session row', async () => {
  const { setHostSessionTabIdMapping, clearHostSessionTabIdMappings } =
    await import('@/runtime/web-session-tabs-sync/tracking-mappings')
  const local = 'structured-agent-session-chat-S'
  const reopened = 'agent-chat-tab-v1-reopened'
  seedStore(store, {
    activeWorktreeId: WORKTREE,
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/tmp/wt-switch' })]
    },
    unifiedTabsByWorktree: {
      [WORKTREE]: [
        makeUnifiedTab({
          id: local,
          entityId: 'chat-S',
          groupId: 'g1',
          worktreeId: WORKTREE,
          contentType: 'agent-session',
          agentSessionAgent: 'codex'
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE]: [
        makeTabGroup({ id: 'g1', worktreeId: WORKTREE, tabOrder: [local] }),
        makeTabGroup({ id: 'g2', worktreeId: WORKTREE, tabOrder: [] })
      ]
    },
    layoutByWorktree: {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: { type: 'leaf', groupId: 'g2' }
      }
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'g1' },
    openFiles: [],
    browserTabsByWorktree: {}
  })
  setHostSessionTabIdMapping(
    { environmentId: 'local', worktreeId: WORKTREE, tabId: local },
    reopened
  )
  registerSessionTabIpcBridge([])
  const groupOf = () =>
    store.getState().unifiedTabsByWorktree[WORKTREE]?.find((entry) => entry.id === local)?.groupId
  try {
    move!({
      worktreeId: WORKTREE,
      tabId: 'agent-session:chat-S',
      targetGroupId: 'g2',
      kind: 'move-to-group',
      index: 0
    })
    expect(groupOf()).toBe('g1')
    move!({
      worktreeId: WORKTREE,
      tabId: reopened,
      targetGroupId: 'g2',
      kind: 'move-to-group',
      index: 0
    })
    expect(groupOf()).toBe('g2')
  } finally {
    clearHostSessionTabIdMappings('local', WORKTREE)
  }
})
