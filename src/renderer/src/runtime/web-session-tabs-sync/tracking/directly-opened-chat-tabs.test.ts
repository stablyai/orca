import { expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { applyWebSessionTabsSnapshot } from '../snapshots/snapshot-api'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState
} from '../testing/web-session-tabs-sync.test-fixture'
import { recordDirectlyOpenedChat } from './directly-opened-chat-tabs'

it('an older inventory cannot erase a directly opened chat and a newer inventory can', () => {
  const chat: Tab = {
    id: 'agent-session:linked',
    entityId: 'linked',
    executionHostId: 'runtime:web-env-1',
    worktreeId: WT,
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Linked chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
  const other = { ...chat, id: 'agent-session:other', entityId: 'other', sortOrder: 1 }
  const state = makeState({
    unifiedTabsByWorktree: { [WT]: [chat, other] },
    groupsByWorktree: {
      [WT]: [
        {
          id: chat.groupId,
          worktreeId: WT,
          activeTabId: chat.id,
          tabOrder: [chat.id, other.id]
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: chat.groupId }
  })
  recordDirectlyOpenedChat(ENV, WT, chat.entityId, {
    tabId: chat.id,
    hostTabId: chat.id,
    registration: undefined,
    connectionGeneration: 0,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 5
  })

  const older = {
    ...state,
    ...applyWebSessionTabsSnapshot(state, makeSnapshot([], { snapshotVersion: 4 }), ENV)
  }
  expect(older.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([chat.id])
  expect(older.groupsByWorktree[WT]?.[0].activeTabId).toBe(chat.id)

  const newer = {
    ...older,
    ...applyWebSessionTabsSnapshot(older, makeSnapshot([], { snapshotVersion: 6 }), ENV)
  }
  expect(newer.unifiedTabsByWorktree[WT] ?? []).toEqual([])
})
