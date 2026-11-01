import type { Worktree, WorkspaceAttachment } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { LinearIssue } from '../../../../shared/linear/issue-types'

export const referenceRepo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/acme/orca',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/acme/orca.git'
  }
}
export const referenceWorkspace: Worktree = {
  id: 'repo::/repo/feature',
  repoId: 'repo',
  path: '/repo/feature',
  displayName: 'Feature',
  branch: 'feature',
  head: 'head',
  comment: '',
  linkedIssue: null,
  linkedPR: 7,
  linkedLinearIssue: null,
  isBare: false,
  isMainWorktree: false,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}
export function referenceAttachment(number = 7): WorkspaceAttachment {
  return {
    provider: 'github',
    type: 'pr',
    number,
    url: `https://github.com/acme/orca/pull/${number}`
  }
}
export function referenceReview(
  number = 7,
  overrides: Partial<HostedReviewInfo> = {}
): HostedReviewInfo {
  const reviewNumber = overrides.number ?? number
  return {
    provider: 'github',
    number: reviewNumber,
    title: `Review ${reviewNumber}`,
    url: `https://github.com/acme/orca/pull/${reviewNumber}`,
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    updatedAt: '2026-10-07',
    ...overrides
  }
}
export function referenceLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  const identifier = overrides.identifier ?? 'ENG-1'
  return {
    id: 'id',
    identifier,
    title: 'Task',
    url: `https://linear.app/acme/issue/${identifier}/title`,
    workspaceId: 'workspace',
    state: { name: 'In Progress', type: 'started', color: '' },
    team: { id: 'team', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-10-07',
    ...overrides
  }
}
