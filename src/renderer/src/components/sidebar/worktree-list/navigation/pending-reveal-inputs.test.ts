import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  expandGroupsForWorktreeReveal,
  type PendingSidebarRevealArgs
} from './pending-reveal-inputs'

const projectGroup: ProjectGroup = {
  id: 'group-platform',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo-1',
  displayName: 'repo-1',
  badgeColor: '#000000',
  addedAt: 1,
  projectGroupId: projectGroup.id
} as Repo

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/workspace/repo-1/wt-1',
  displayName: 'wt-1',
  branch: 'feature',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 1,
  workspaceStatus: 'in-progress'
}

function makeArgs(collapsedGroups: Set<string>, toggleGroup: (key: string) => void) {
  return {
    pendingRevealWorktree: null,
    pendingRevealSidebarRow: null,
    clearPendingRevealWorktreeId: vi.fn(),
    clearPendingRevealSidebarRow: vi.fn(),
    agentSendTargetWorktreeId: null,
    renderRows: [],
    virtualizer: {},
    scrollRef: { current: null },
    worktrees: [worktree],
    folderWorkspaces: [],
    repoMap: new Map([[repo.id, repo]]),
    worktreeMap: new Map([[worktree.id, worktree]]),
    worktreeLineageById: {},
    collapsedGroups,
    toggleGroup,
    groupBy: 'workspace-status',
    groupBySecondary: 'repo',
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: 'local',
    prCache: null,
    workspaceStatuses: [],
    settings: undefined,
    projectGroups: [projectGroup],
    projectGrouping: undefined,
    flashRevealedRow: vi.fn(),
    markRevealScroll: vi.fn(),
    schedulePendingRevealFrame: vi.fn(),
    cancelPendingRevealFrames: vi.fn()
  } as unknown as PendingSidebarRevealArgs
}

describe('expandGroupsForWorktreeReveal', () => {
  it('expands a collapsed secondary Project Group ancestor during navigation', () => {
    const nestedGroupKey = 'workspace-status:in-progress/project-group:group-platform'
    const toggleGroup = vi.fn()

    expandGroupsForWorktreeReveal(makeArgs(new Set([nestedGroupKey]), toggleGroup), worktree.id)

    expect(toggleGroup).toHaveBeenCalledExactlyOnceWith(nestedGroupKey)
  })
})
