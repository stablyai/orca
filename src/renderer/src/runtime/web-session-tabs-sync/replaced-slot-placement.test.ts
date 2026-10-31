import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { ReplacedTab } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import type { WebSessionTabsSyncState } from './state'
import { recordWebSessionFocusIntent } from '../web-session-focus-intent'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

type Row = RuntimeMobileSessionTabsResult['tabs'][number]

const terminal = (hostTabId: string, extra: { replaces?: ReplacedTab } = {}): Row => ({
  type: 'terminal',
  id: `${hostTabId}::${LEAF_ID}`,
  parentTabId: hostTabId,
  leafId: LEAF_ID,
  title: hostTabId,
  isActive: false,
  status: 'ready',
  terminal: `handle-${hostTabId}`,
  ...extra
})

const chat: Row = {
  type: 'agent-session',
  id: 'agent-session:session-1',
  title: 'Codex',
  sessionId: 'session-1',
  agent: 'codex',
  isActive: false
}

function apply(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
  return patch === state ? state : { ...state, ...patch }
}

beforeEach(resetWebSessionTabsSyncTestState)

it('puts a terminal that replaced a chat where this client showed the chat', () => {
  const shown = apply(
    makeState(),
    makeSnapshot([terminal('host-a'), chat, terminal('host-b')], {
      tabGroups: [
        {
          id: 'host-group-1',
          activeTabId: null,
          tabOrder: ['host-a', chat.id, 'host-b']
        }
      ]
    })
  )
  const group = shown.groupsByWorktree[WT]![0]!
  const chatTabId = group.tabOrder[1]!
  expect(shown.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === chatTabId)?.entityId).toBe(
    'session-1'
  )
  // This client moved the chat first; the host's order still has it in the middle.
  const moved = {
    ...shown,
    groupsByWorktree: {
      [WT]: [{ ...group, tabOrder: [chatTabId, group.tabOrder[0]!, group.tabOrder[2]!] }]
    }
  }
  const replaced = apply(
    moved,
    makeSnapshot(
      [
        terminal('host-a'),
        terminal('host-switched', { replaces: { tabId: chat.id } }),
        terminal('host-b')
      ],
      {
        snapshotVersion: 2,
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: null,
            tabOrder: ['host-a', 'host-switched', 'host-b']
          }
        ]
      }
    )
  )
  const order = replaced.groupsByWorktree[WT]![0]!.tabOrder
  const switched = replaced.unifiedTabsByWorktree[WT]?.find(
    (tab) => tab.contentType === 'terminal' && tab.label === 'host-switched'
  )
  expect(switched).toBeDefined()
  expect(order).toEqual([switched!.id, group.tabOrder[0], group.tabOrder[2]])
})

const chatAfter = (tabId: string): Row => ({ ...chat, after: { tabId } })

/** This client shows host-a, host-b, host-c in one group, its own order, with `active` selected. */
function shownThree(active: 'host-a' | 'host-b') {
  const shown = apply(
    makeState(),
    makeSnapshot([terminal('host-a'), terminal('host-b'), terminal('host-c')], {
      tabGroups: [
        { id: 'host-group-1', activeTabId: null, tabOrder: ['host-a', 'host-b', 'host-c'] }
      ]
    })
  )
  const group = shown.groupsByWorktree[WT]![0]!
  const [a, b, c] = [group.tabOrder[0]!, group.tabOrder[1]!, group.tabOrder[2]!]
  const local = { 'host-a': a, 'host-b': b }
  // The host's order differs: this client moved host-c first.
  const state = {
    ...shown,
    groupsByWorktree: { [WT]: [{ ...group, tabOrder: [c, a, b], activeTabId: local[active] }] }
  }
  return { state, a, b, c }
}

it.each([
  ['the initiator, still on the split pane’s tab', 'host-a', true, 'chat'],
  ['the initiator, after clicking to another tab', 'host-b', true, 'host-b'],
  ['another viewer showing the split pane’s tab', 'host-a', false, 'host-a']
] as const)(
  'opens a chat beside the split pane it came from; only its initiator follows: %s',
  (_name, active, initiated, selected) => {
    const { state, a, b, c } = shownThree(active)
    if (initiated) {
      // Named a chat the host then reused: the intent still matches by the slot.
      recordWebSessionFocusIntent(
        { environmentId: ENV },
        WT,
        'agent-session:minted',
        undefined,
        a,
        'host-a'
      )
    }
    const next = apply(
      state,
      makeSnapshot(
        [terminal('host-a'), terminal('host-b'), terminal('host-c'), chatAfter('host-a')],
        {
          snapshotVersion: 2,
          tabGroups: [
            {
              id: 'host-group-1',
              activeTabId: null,
              tabOrder: ['host-a', 'host-b', 'host-c', chat.id]
            }
          ]
        }
      )
    )
    const group = next.groupsByWorktree[WT]![0]!
    const chatTab = next.unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === 'session-1')!
    expect(group.tabOrder).toEqual([c, a, chatTab.id, b])
    expect(group.activeTabId).toBe({ chat: chatTab.id, 'host-a': a, 'host-b': b }[selected])
  }
)

it.each([
  [true, undefined, true],
  // The pin is this client's own: a host flag on the new row never overrides it.
  [false, true, false]
] as const)(
  'keeps this client’s pin on the replaced tab (client pinned=%s, host pinned=%s)',
  (clientPinned, hostPinned, expected) => {
    const shown = apply(
      makeState(),
      makeSnapshot([chat, terminal('host-b')], {
        tabGroups: [{ id: 'host-group-1', activeTabId: null, tabOrder: [chat.id, 'host-b'] }]
      })
    )
    const state = {
      ...shown,
      unifiedTabsByWorktree: {
        [WT]: shown.unifiedTabsByWorktree[WT]!.map((tab) =>
          tab.entityId === 'session-1' ? { ...tab, isPinned: clientPinned } : tab
        )
      }
    }
    const next = apply(
      state,
      makeSnapshot(
        [
          {
            ...terminal('host-switched', { replaces: { tabId: chat.id } }),
            ...(hostPinned ? { isPinned: true } : {})
          },
          terminal('host-b')
        ],
        {
          snapshotVersion: 2,
          tabGroups: [
            { id: 'host-group-1', activeTabId: null, tabOrder: ['host-switched', 'host-b'] }
          ]
        }
      )
    )
    const switched = next.unifiedTabsByWorktree[WT]!.find((tab) => tab.label === 'host-switched')!
    expect(switched.isPinned).toBe(expected)
    expect(next.tabsByWorktree[WT]!.find((tab) => tab.id === switched.id)?.isPinned).toBe(expected)
  }
)

it('keeps the pin a chat took from the terminal it replaced, until the host’s own pin changes', () => {
  const { state } = shownThree('host-a')
  // The host pinned its terminal; this client never did.
  const frame = (snapshotVersion: number, hostPinned: boolean) =>
    makeSnapshot(
      [
        { ...chat, replaces: { tabId: 'host-a' }, isPinned: hostPinned },
        terminal('host-b'),
        terminal('host-c')
      ],
      {
        snapshotVersion,
        tabGroups: [
          { id: 'host-group-1', activeTabId: null, tabOrder: [chat.id, 'host-b', 'host-c'] }
        ]
      }
    )
  const pinned = (next: WebSessionTabsSyncState) =>
    next.unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === 'session-1')?.isPinned
  const first = apply(state, frame(2, true))
  const second = apply(first, frame(3, true))
  expect([pinned(first), pinned(second)]).toEqual([false, false])
  // The desktop user unpins it, then pins it again: from the first change, the host decides.
  const unpinned = apply(second, frame(4, false))
  const repinned = apply(unpinned, frame(5, true))
  expect([pinned(unpinned), pinned(repinned)]).toEqual([false, true])
})

it('places a destination in a split group this client is not looking at, without moving focus', () => {
  const { state, a, b, c } = shownThree('host-a')
  const [group] = state.groupsByWorktree[WT]!
  // Two groups here: host-c alone in the active one, the source in the other (order unlike the host).
  const twoGroups = {
    ...state,
    groupsByWorktree: {
      [WT]: [
        { ...group!, id: 'local-left', tabOrder: [c], activeTabId: c },
        { ...group!, id: 'local-right', tabOrder: [b, a], activeTabId: a }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'local-left' }
  }
  const next = apply(
    twoGroups,
    makeSnapshot(
      [
        terminal('host-switched', { replaces: { tabId: 'host-a' } }),
        terminal('host-b'),
        terminal('host-c')
      ],
      {
        snapshotVersion: 2,
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: null,
            tabOrder: ['host-switched', 'host-b', 'host-c']
          }
        ]
      }
    )
  )
  const switched = next.unifiedTabsByWorktree[WT]!.find((tab) => tab.label === 'host-switched')!
  const right = next.groupsByWorktree[WT]!.find((entry) => entry.id === 'local-right')!
  expect(right.tabOrder).toEqual([b, switched.id])
  expect(right.activeTabId).toBe(switched.id)
  expect(switched.groupId).toBe('local-right')
  expect(next.activeGroupIdByWorktree[WT]).toBe('local-left')
})

it.each([
  ['shows the replaced tab', 'host-a', 'agent-session'],
  ['moved to another tab', 'host-b', 'terminal']
] as const)(
  'focuses a chat that replaced a terminal only when this client %s, before any answer',
  (_name, active, visibleType) => {
    const { state } = shownThree(active)
    const next = apply(
      { ...state, activeGroupIdByWorktree: { [WT]: state.groupsByWorktree[WT]![0]!.id } },
      makeSnapshot(
        [{ ...chat, replaces: { tabId: 'host-a' } }, terminal('host-b'), terminal('host-c')],
        {
          snapshotVersion: 2,
          tabGroups: [
            { id: 'host-group-1', activeTabId: null, tabOrder: [chat.id, 'host-b', 'host-c'] }
          ]
        }
      )
    )
    expect(next.activeTabTypeByWorktree[WT] ?? next.activeTabType).toBe(visibleType)
  }
)
