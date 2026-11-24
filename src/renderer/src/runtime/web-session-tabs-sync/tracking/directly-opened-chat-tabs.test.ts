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

it('startup and older inventories cannot erase an early chat before the current inventory', () => {
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
    receivedFrame: 5,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 5
  })

  const startup = {
    ...state,
    ...applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([], { publicationEpoch: 'none', snapshotVersion: 0 }),
      ENV
    )
  }
  const delayedList = {
    ...startup,
    ...applyWebSessionTabsSnapshot(
      startup,
      makeSnapshot([], { publicationEpoch: 'epoch-0', snapshotVersion: 9 }),
      ENV,
      NOW,
      { requestReceivedFrame: 4 }
    )
  }
  expect(delayedList.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([chat.id])

  const older = {
    ...delayedList,
    ...applyWebSessionTabsSnapshot(delayedList, makeSnapshot([], { snapshotVersion: 4 }), ENV)
  }
  expect(older.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([chat.id])
  expect(older.groupsByWorktree[WT]?.[0].activeTabId).toBe(chat.id)

  const newer = {
    ...older,
    ...applyWebSessionTabsSnapshot(
      older,
      makeSnapshot([], { publicationEpoch: 'epoch-2', snapshotVersion: 1 }),
      ENV,
      NOW,
      { requestReceivedFrame: 6 }
    )
  }
  expect(newer.unifiedTabsByWorktree[WT] ?? []).toEqual([])
})

it.each(['empty', 'populated'])('keeps the split after an older %s frame', (older) => {
  const sessionId = 'cold-link'
  const hostTabId = 'agent-session:cold-link'
  const localTabId = 'local-cold-link'
  const localGroupId = 'temporary-root'
  const linked: Tab = {
    id: localTabId,
    entityId: sessionId,
    executionHostId: 'runtime:web-env-1',
    worktreeId: WT,
    groupId: localGroupId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Linked chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
  const state = makeState({
    activeTabType: 'agent-session',
    unifiedTabsByWorktree: { [WT]: [linked] },
    groupsByWorktree: {
      [WT]: [{ id: localGroupId, worktreeId: WT, tabOrder: [localTabId], activeTabId: localTabId }]
    },
    activeGroupIdByWorktree: { [WT]: localGroupId },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: localGroupId } }
  })
  recordDirectlyOpenedChat(ENV, WT, sessionId, {
    tabId: localTabId,
    hostTabId,
    hostGroupId: 'right',
    registration: undefined,
    connectionGeneration: 0,
    receivedFrame: 5,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 5,
    initialGroupId: localGroupId
  })
  const layout = {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', groupId: 'left' },
    second: { type: 'leaf', groupId: 'right' }
  } as const
  const frame = makeSnapshot(
    [
      {
        type: 'agent-session',
        id: hostTabId,
        sessionId,
        title: 'Linked chat',
        agent: 'codex',
        isActive: false
      },
      {
        type: 'agent-session',
        id: 'agent-session:neighbor',
        sessionId: 'neighbor',
        title: 'Neighbor',
        agent: 'codex',
        isActive: true
      }
    ],
    {
      snapshotVersion: 5,
      activeGroupId: 'left',
      activeTabId: 'agent-session:neighbor',
      activeTabType: 'agent-session',
      tabGroupLayout: layout,
      tabGroups: [
        { id: 'left', activeTabId: 'agent-session:neighbor', tabOrder: ['agent-session:neighbor'] },
        { id: 'right', activeTabId: hostTabId, tabOrder: [hostTabId] }
      ]
    }
  )
  const olderFrame =
    older === 'populated'
      ? { ...frame, snapshotVersion: 4 }
      : makeSnapshot([], {
          snapshotVersion: 4,
          activeGroupId: 'left',
          tabGroupLayout: { type: 'leaf', groupId: 'left' },
          tabGroups: [{ id: 'left', activeTabId: null, tabOrder: [] }]
        })
  const afterOlderFrame = { ...state, ...applyWebSessionTabsSnapshot(state, olderFrame, ENV) }
  expect(afterOlderFrame.activeGroupIdByWorktree[WT]).toBe(
    older === 'populated' ? 'right' : localGroupId
  )

  const next = { ...afterOlderFrame, ...applyWebSessionTabsSnapshot(afterOlderFrame, frame, ENV) }
  expect(next.layoutByWorktree[WT]).toEqual(layout)
  expect(next.activeGroupIdByWorktree[WT]).toBe('right')
  expect(next.groupsByWorktree[WT]?.find((group) => group.id === 'right')?.tabOrder).toEqual([
    localTabId
  ])
  expect(next.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === localTabId)?.groupId).toBe(
    'right'
  )
})
