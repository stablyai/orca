import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceAttachment, Worktree } from '../../../../../../shared/worktree/types'
import { normalizeTaskSourceContext } from '../../../../../../shared/task-source-context'
import {
  getWorkspaceAttachmentSourceContext,
  matchesWorkspaceAttachmentQuery
} from './workspace-attachment-source-result'

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '',
  addedAt: 1,
  connectionId: 'remote'
}
const worktree: Worktree = {
  id: 'workspace',
  repoId: 'repo',
  path: '/repo/feature',
  displayName: 'Feature',
  branch: 'feature',
  head: 'abc',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isBare: false,
  isMainWorktree: false,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const review: WorkspaceAttachment = {
  provider: 'github',
  type: 'pr',
  number: 7,
  url: 'https://github.com/acme/orca/pull/7',
  repoId: 'repo'
}

describe('attachment source conversion', () => {
  it('uses legacy SSH ownership and preserves the saved provider source', () => {
    expect(getWorkspaceAttachmentSourceContext('gitlab', repo, worktree)?.hostId).toBe('ssh:remote')
    const stored = normalizeTaskSourceContext({
      provider: 'linear',
      projectId: 'other',
      hostId: 'runtime:saved'
    })
    const saved = { ...worktree, linkedTaskSourceContext: stored }
    expect(getWorkspaceAttachmentSourceContext('linear', repo, saved)).toBe(stored)
    expect(getWorkspaceAttachmentSourceContext('github', repo, saved)?.projectId).toBe('repo')
    expect(getWorkspaceAttachmentSourceContext('github', repo, saved)?.hostId).toBe('ssh:remote')
  })
  it('only enriches the same symbolic identifier and URL source', () => {
    const task: WorkspaceAttachment = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: 'STA-71'
    }
    expect(matchesWorkspaceAttachmentQuery(task, { ...task, identifier: 'STA-710' })).toBe(false)
    expect(matchesWorkspaceAttachmentQuery(task, { ...task, identifier: 'sta-71' })).toBe(true)
    expect(
      matchesWorkspaceAttachmentQuery(review, {
        ...review,
        url: 'https://github.com/other/orca/pull/7'
      })
    ).toBe(false)
  })
})
