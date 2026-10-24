// @vitest-environment happy-dom

import { beforeEach, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../lib/worktree-runtime-owner-state'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { structuredAgentSessionOwnerForTab } from './structured-agent-session-owner'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT
} from './web-session-tabs-sync-test-harness'

const SESSION = 'legacy-session'
const TAB_ID = 'restored-chat'
const GROUP_ID = 'restored-group'
const FOLDER = 'folder:shared-folder'
type OwnerState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState
const OWNERS = [
  { worktree: WT, host: 'runtime:owner', owner: 'owner', peer: 'peer' },
  { worktree: FOLDER, host: 'runtime:owner', owner: 'owner', peer: 'peer' },
  { worktree: WT, host: 'local', owner: LOCAL_STRUCTURED_SESSION_OWNER, peer: 'peer' },
  { worktree: FOLDER, host: 'local', owner: LOCAL_STRUCTURED_SESSION_OWNER, peer: 'peer' },
  { worktree: WT, host: 'runtime:owner', owner: 'owner', peer: LOCAL_STRUCTURED_SESSION_OWNER },
  { worktree: FOLDER, host: 'runtime:owner', owner: 'owner', peer: LOCAL_STRUCTURED_SESSION_OWNER }
] as const

function restoredState(worktreeId: string, ownership: WorktreeRuntimeOwnerState): OwnerState {
  const tab: Tab = {
    id: TAB_ID,
    entityId: SESSION,
    worktreeId,
    groupId: GROUP_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'pi',
    label: 'Existing conversation',
    customLabel: 'Keep this title',
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return {
    ...makeState({
      activeWorktreeId: worktreeId,
      activeTabId: TAB_ID,
      activeTabType: 'agent-session',
      activeTabIdByWorktree: { [worktreeId]: TAB_ID },
      activeTabTypeByWorktree: { [worktreeId]: 'agent-session' },
      activeGroupIdByWorktree: { [worktreeId]: GROUP_ID },
      unifiedTabsByWorktree: { [worktreeId]: [tab] },
      groupsByWorktree: {
        [worktreeId]: [{ id: GROUP_ID, worktreeId, activeTabId: TAB_ID, tabOrder: [TAB_ID] }]
      }
    }),
    ...ownership
  }
}

function chatSnapshot(worktree: string) {
  return makeSnapshot(
    [
      {
        type: 'agent-session',
        id: 'host-chat',
        sessionId: SESSION,
        agent: 'pi',
        title: 'Existing conversation',
        isActive: true
      }
    ],
    { worktree, activeTabId: 'host-chat', activeTabType: 'agent-session' }
  )
}

beforeEach(resetWebSessionTabsSyncTestState)

it.each(OWNERS)(
  'keeps the restored $worktree chat on $host when $peer publishes its session',
  ({ worktree, host, peer }) => {
    const state = restoredState(worktree, { activeWorkspaceExecutionHostId: host })
    const original = state.unifiedTabsByWorktree[worktree]![0]!
    expect(structuredAgentSessionOwnerForTab(state, original)).toBe(host)

    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, chatSnapshot(worktree), peer, 2)
    }
    const retained = next.unifiedTabsByWorktree[worktree]?.find((tab) => tab.id === TAB_ID)
    expect(retained).toMatchObject({ entityId: SESSION, customLabel: 'Keep this title' })
    expect(structuredAgentSessionOwnerForTab(next, retained!)).toBe(host)
    expect(next.unifiedTabsByWorktree[worktree]).toHaveLength(2)
    expect(next.groupsByWorktree[worktree]?.[0]?.activeTabId).toBe(TAB_ID)
  }
)

it.each(OWNERS.filter(({ peer }) => peer === 'peer'))(
  'lets $host adopt its restored $worktree chat under the same local tab ID',
  ({ worktree, host, owner }) => {
    const state = restoredState(worktree, { activeWorkspaceExecutionHostId: host })
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, chatSnapshot(worktree), owner, 2)
    }
    expect(next.unifiedTabsByWorktree[worktree]).toEqual([
      expect.objectContaining({
        id: TAB_ID,
        entityId: SESSION,
        executionHostId: host,
        customLabel: 'Keep this title',
        groupId: GROUP_ID
      })
    ])
    expect(next.groupsByWorktree[worktree]?.[0]?.activeTabId).toBe(TAB_ID)
  }
)

it.each(OWNERS)(
  'does not replace the restored $worktree chat on $host from $peer',
  ({ worktree, host, peer }) => {
    const state = restoredState(worktree, { activeWorkspaceExecutionHostId: host })
    const replacement = makeSnapshot(
      [
        {
          type: 'agent-session',
          id: 'new-host-chat',
          sessionId: 'replacement-session',
          replacesSessionId: SESSION,
          agent: 'pi',
          title: 'New conversation',
          isActive: true
        }
      ],
      { worktree, activeTabId: 'new-host-chat', activeTabType: 'agent-session' }
    )
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, replacement, peer, 2)
    }
    expect(next.unifiedTabsByWorktree[worktree]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: TAB_ID, entityId: SESSION, executionHostId: host }),
        expect.objectContaining({ entityId: 'replacement-session' })
      ])
    )
    expect(next.unifiedTabsByWorktree[worktree]).toHaveLength(2)
    expect(next.groupsByWorktree[worktree]?.[0]?.activeTabId).toBe(TAB_ID)
  }
)

it.each(OWNERS)(
  'retires the restored $worktree chat only after $host affirms it is absent',
  ({ worktree, host, owner, peer }) => {
    const state = restoredState(worktree, { activeWorkspaceExecutionHostId: host })
    const empty = makeSnapshot([], { worktree, activeTabId: null, activeTabType: null })
    const retained = { ...state, ...applyWebSessionTabsSnapshot(state, empty, peer, 2) }
    expect(retained.unifiedTabsByWorktree[worktree]).toEqual([
      expect.objectContaining({ id: TAB_ID, entityId: SESSION, executionHostId: host })
    ])
    const retired = { ...retained, ...applyWebSessionTabsSnapshot(retained, empty, owner, 3) }
    expect(retired.unifiedTabsByWorktree[worktree] ?? []).toEqual([])
  }
)

it.each([
  { label: 'unverifiable', agentSessionsUnverifiable: true as const },
  { label: 'unpublished', publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH }
])('retains the legacy chat when its own inventory is $label', ({ label: _label, ...flags }) => {
  const state = restoredState(WT, { activeWorkspaceExecutionHostId: 'runtime:owner' })
  const frame = makeSnapshot([], { ...flags, activeTabId: null, activeTabType: null })
  const next = { ...state, ...applyWebSessionTabsSnapshot(state, frame, 'owner', 2) }
  expect(next.unifiedTabsByWorktree[WT]).toEqual([
    expect.objectContaining({ id: TAB_ID, entityId: SESSION, executionHostId: 'runtime:owner' })
  ])
})

it.each([WT, FOLDER])('still adopts a legacy %s chat when its catalog has no owner', (worktree) => {
  const state = restoredState(worktree, {})
  const next = {
    ...state,
    ...applyWebSessionTabsSnapshot(state, chatSnapshot(worktree), 'peer', 2)
  }
  expect(next.unifiedTabsByWorktree[worktree]).toEqual([
    expect.objectContaining({ id: TAB_ID, entityId: SESSION, executionHostId: 'runtime:peer' })
  ])
})

it.each([
  {
    worktree: WT,
    ownership: {
      repos: [
        { id: 'repo', executionHostId: 'runtime:owner' },
        { id: 'repo', executionHostId: 'runtime:peer' }
      ]
    }
  },
  {
    worktree: FOLDER,
    ownership: {
      folderWorkspaces: [
        { id: 'shared-folder', projectGroupId: 'project', executionHostId: 'runtime:owner' },
        { id: 'shared-folder', projectGroupId: 'project', executionHostId: 'runtime:peer' }
      ]
    }
  }
] satisfies { worktree: string; ownership: WorktreeRuntimeOwnerState }[])(
  'does not invent a legacy owner when the $worktree catalog is ambiguous',
  ({ worktree, ownership }) => {
    const state = restoredState(worktree, ownership)
    expect(
      structuredAgentSessionOwnerForTab(state, state.unifiedTabsByWorktree[worktree]![0]!)
    ).toBeNull()
    const next = {
      ...state,
      ...applyWebSessionTabsSnapshot(state, chatSnapshot(worktree), 'peer', 2)
    }
    expect(next.unifiedTabsByWorktree[worktree]).toEqual([
      expect.objectContaining({ id: TAB_ID, entityId: SESSION, executionHostId: 'runtime:peer' })
    ])
  }
)

it('keeps the established owner when workspace selection later changes to the peer', () => {
  let state = restoredState(WT, { activeWorkspaceExecutionHostId: 'runtime:owner' })
  const empty = makeSnapshot([], { activeTabId: null, activeTabType: null })
  state = { ...state, ...applyWebSessionTabsSnapshot(state, empty, 'peer', 2) }
  state = { ...state, activeWorkspaceExecutionHostId: 'runtime:peer' }
  state = { ...state, ...applyWebSessionTabsSnapshot(state, chatSnapshot(WT), 'peer', 3) }
  expect(state.unifiedTabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)).toMatchObject({
    entityId: SESSION,
    executionHostId: 'runtime:owner'
  })
})

it.each([
  { worktree: WT, ownership: { repos: [{ id: 'repo', executionHostId: 'runtime:owner' }] } },
  {
    worktree: FOLDER,
    ownership: {
      folderWorkspaces: [
        {
          id: 'shared-folder',
          projectGroupId: 'project',
          executionHostId: 'runtime:owner'
        }
      ]
    }
  }
] satisfies { worktree: string; ownership: WorktreeRuntimeOwnerState }[])(
  'uses catalog ownership for an inactive restored $worktree chat',
  ({ worktree, ownership }) => {
    const state = restoredState(worktree, { ...ownership, activeWorktreeId: 'other-workspace' })
    const empty = makeSnapshot([], { worktree, activeTabId: null, activeTabType: null })
    const next = { ...state, ...applyWebSessionTabsSnapshot(state, empty, 'peer', 2) }
    expect(next.unifiedTabsByWorktree[worktree]).toEqual([
      expect.objectContaining({ id: TAB_ID, executionHostId: 'runtime:owner' })
    ])
  }
)
