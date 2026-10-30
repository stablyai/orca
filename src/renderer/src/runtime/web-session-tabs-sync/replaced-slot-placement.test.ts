import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import type { WebSessionTabsSyncState } from './state'
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

const terminal = (hostTabId: string, extra: Partial<Row> = {}): Row =>
  ({
    type: 'terminal',
    id: `${hostTabId}::${LEAF_ID}`,
    parentTabId: hostTabId,
    leafId: LEAF_ID,
    title: hostTabId,
    isActive: false,
    status: 'ready',
    terminal: `handle-${hostTabId}`,
    ...extra
  }) as Row

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
