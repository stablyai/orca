import { rawWorkspaceState } from '../workspace-source-state'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { expect } from 'vitest'
import {
  createTestStore,
  makeUnifiedTab,
  makeTabGroup,
  makeWorktree,
  makeOpenFile
} from './store-test-helpers'
import { mergeListedWorktreeSpellings } from './worktrees/session/worktree-spelling-merge'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
export const O = 'r::C:\\repo'
export const D = 'r::C:/repo'
export const C1 = 'structured-agent-session-chat1'
export const C2 = 'structured-agent-session-chat2'
export const listing = {
  worktrees: [makeWorktree({ id: D, repoId: 'r', path: 'C:/repo' })],
  authoritative: true,
  source: 'git' as const
}
export const split = {
  type: 'split' as const,
  direction: 'horizontal' as const,
  ratio: 0.37,
  first: { type: 'leaf' as const, groupId: 'left' },
  second: { type: 'leaf' as const, groupId: 'right' }
}
export function seed(hostId: ExecutionHostId = 'local') {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: 'r',
        path: 'C:/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: hostId
      }
    ],
    worktreesByRepo: { r: listing.worktrees.map((row) => ({ ...row, hostId })) },
    activeRepoId: 'r',
    activeWorktreeId: D,
    unifiedTabsByWorktree: {
      [O]: [
        makeUnifiedTab({
          id: C1,
          entityId: 'chat1',
          worktreeId: O,
          groupId: 'source',
          contentType: 'agent-session',
          executionHostId: hostId,
          agentSessionAgent: 'codex',
          customLabel: 'Saved name'
        })
      ],
      [D]: [
        makeUnifiedTab({
          id: C2,
          entityId: 'chat2',
          worktreeId: D,
          groupId: 'right',
          contentType: 'agent-session',
          executionHostId: hostId,
          agentSessionAgent: 'claude'
        })
      ]
    },
    groupsByWorktree: {
      [O]: [makeTabGroup({ id: 'source', worktreeId: O, tabOrder: [C1], activeTabId: C1 })],
      [D]: [
        makeTabGroup({ id: 'left', worktreeId: D }),
        makeTabGroup({ id: 'right', worktreeId: D, tabOrder: [C2], activeTabId: C2 })
      ]
    },
    layoutByWorktree: { [O]: { type: 'leaf', groupId: 'source' }, [D]: split },
    activeGroupIdByWorktree: { [O]: 'source', [D]: 'right' }
  })
  store.setState(
    mergeListedWorktreeSpellings(store.getState(), 'r', hostId, {
      worktrees: store.getState().worktreesByRepo.r
    })
  )
  expect(
    store.getState().moveUnifiedTabToGroup(C1, 'left', { activate: true, recordInteraction: false })
  ).toBe(true)
  return store
}
export function assertU(store: ReturnType<typeof seed>) {
  const state = store.getState()
  expect(state.unifiedTabsByWorktree[D].map((tab) => tab.id).sort()).toEqual([C1, C2])
  expect(state.unifiedTabsByWorktree[D].find((tab) => tab.id === C1)).toMatchObject({
    worktreeId: O,
    groupId: 'left',
    customLabel: 'Saved name'
  })
  expect(state.layoutByWorktree[D]).toEqual(split)
  expect(state.activeGroupIdByWorktree[D]).toBe('left')
  expect(
    state.groupsByWorktree[D].map((group) => [group.id, group.tabOrder, group.activeTabId])
  ).toEqual([
    ['left', [C1], C1],
    ['right', [C2], C2]
  ])
}
export function frame(
  worktree: string,
  sessionId: string,
  version: number,
  tabs = true
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: `epoch:${worktree}`,
    snapshotVersion: version,
    tabs: tabs
      ? [
          {
            type: 'agent-session',
            id: sessionId === 'chat1' ? 'chat-host-id' : 'destination-chat',
            sessionId,
            agent: sessionId === 'chat1' ? 'codex' : 'claude',
            title: 'Host title',
            isActive: true
          }
        ]
      : [],
    activeTabType: 'agent-session',
    activeTabId: null,
    activeGroupId: null
  }
}

export function seedEditors() {
  const store = seed()
  const raw = rawWorkspaceState(store.getState())
  const file = makeOpenFile({ id: 'owned', worktreeId: O, isDirty: true })
  const foreign = makeOpenFile({
    id: 'foreign',
    worktreeId: O,
    runtimeEnvironmentId: 'box',
    isDirty: true
  })
  store.setState({
    openFiles: [file, foreign],
    editorDrafts: { owned: 'unsaved original', foreign: 'other host' },
    unifiedTabsByWorktree: {
      ...raw.unifiedTabsByWorktree,
      [O]: [
        ...raw.unifiedTabsByWorktree[O],
        makeUnifiedTab({
          id: 'editor',
          entityId: file.id,
          worktreeId: O,
          groupId: 'source',
          contentType: 'editor'
        })
      ]
    }
  })
  store
    .getState()
    .moveUnifiedTabToGroup('editor', 'left', { activate: true, recordInteraction: false })
  return store
}
