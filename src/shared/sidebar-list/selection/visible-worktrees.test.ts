import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import {
  NO_WORKSPACE_ROW_FILTERS,
  type WorkspaceRowFactReader
} from '../../workspace-view/workspace-row-filters'
import { selectVisibleSidebarWorktrees } from './visible-worktrees'

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: `/repo/${id}`,
    head: 'abc',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false
  }
}

const parent = makeWorktree('parent')
const child = makeWorktree('child')
const statusById: Record<string, string> = { parent: 'done', child: 'in-progress' }

const facts: WorkspaceRowFactReader<Worktree> = {
  isArchived: () => false,
  isInHiddenProject: () => false,
  isProjectHidden: () => false,
  isFolderWorkspace: () => false,
  repoId: (row) => row.repoId,
  hostId: () => 'local',
  isOtherClient: () => false,
  isDefaultBranch: () => false,
  isAutomationCreated: () => false,
  isCliCreated: () => false,
  isDetachedHead: () => false,
  isMainWorktree: () => false,
  isSleeping: () => false,
  workspaceStatus: (row) => statusById[row.id] ?? 'todo'
}

function visibleIds(filters: typeof NO_WORKSPACE_ROW_FILTERS): string[] {
  return selectVisibleSidebarWorktrees({
    rows: [parent, child],
    ancestorByIdentity: new Map([parent, child].map((row) => [getWorktreeHostIdentity(row), row])),
    rankOf: (row) => (row.id === 'parent' ? 0 : 1),
    filters,
    facts,
    worktreeLineageById: {},
    lineageParentIdentities: new Map([
      [getWorktreeHostIdentity(child), getWorktreeHostIdentity(parent)]
    ]),
    filterRepoIds: []
  }).map((row) => row.id)
}

describe('selectVisibleSidebarWorktrees lineage ancestors', () => {
  it('keeps a parent hidden by status out even when its child is visible', () => {
    expect(
      visibleIds({
        ...NO_WORKSPACE_ROW_FILTERS,
        hideWorkspacesByStatus: true,
        hiddenWorkspaceStatusIds: ['done']
      })
    ).toEqual(['child'])
  })
})
