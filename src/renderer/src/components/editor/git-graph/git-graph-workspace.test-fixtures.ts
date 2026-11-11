import type { Worktree } from '../../../../../shared/worktree/types'
import type { Repo } from '../../../../../shared/repo-types'

export const workspaceId = 'r::/repo'
export const local: Worktree = {
  id: workspaceId,
  repoId: 'r',
  path: '/repo',
  branch: 'refs/heads/main',
  hostId: 'local',
  head: 'a',
  isBare: false,
  isMainWorktree: true,
  displayName: 'repo',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}
export const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}
