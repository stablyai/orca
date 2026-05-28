import { describe, expect, it } from 'vitest'

import {
  findGithubPrWorkspaceAttachment,
  getGithubPrWorkspaceAttachmentLabel
} from './github-pr-workspace-attachment'
import type { Worktree } from '../../../shared/types'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/pr-workspace',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'PR workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('github PR workspace attachment', () => {
  it('finds the first non-archived workspace linked to the repo PR', () => {
    const first = worktree({ id: 'first', linkedPR: 42 })
    const second = worktree({ id: 'second', linkedPR: 42 })

    expect(findGithubPrWorkspaceAttachment([first, second], 'repo-1', 42)).toBe(first)
  })

  it('does not match workspaces from a different repo', () => {
    const attachedElsewhere = worktree({ repoId: 'repo-2', linkedPR: 42 })

    expect(findGithubPrWorkspaceAttachment([attachedElsewhere], 'repo-1', 42)).toBeNull()
  })

  it('does not match archived workspaces', () => {
    const archived = worktree({ linkedPR: 42, isArchived: true })

    expect(findGithubPrWorkspaceAttachment([archived], 'repo-1', 42)).toBeNull()
  })

  it('returns null when no GitHub PR attachment exists', () => {
    const unlinked = worktree({ linkedPR: null })

    expect(findGithubPrWorkspaceAttachment([unlinked], 'repo-1', 42)).toBeNull()
  })

  it('does not treat GitLab MR metadata as a GitHub PR attachment', () => {
    const gitlabOnly = worktree({ linkedPR: null, linkedGitLabMR: 42 })

    expect(findGithubPrWorkspaceAttachment([gitlabOnly], 'repo-1', 42)).toBeNull()
  })

  it('labels attachments without exposing a full path when display or branch is available', () => {
    expect(getGithubPrWorkspaceAttachmentLabel(worktree({ displayName: '  Named PR  ' }))).toBe(
      'Named PR'
    )
    expect(
      getGithubPrWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: 'refs/heads/fix-ci' })
      )
    ).toBe('fix-ci')
    expect(
      getGithubPrWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: '', path: 'C:\\repo\\workspace-tail' })
      )
    ).toBe('workspace-tail')
  })
})
