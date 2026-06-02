import { describe, expect, it } from 'vitest'

import {
  findGithubIssueWorkspaceAttachment,
  findGithubPrWorkspaceAttachment,
  findGithubWorkItemWorkspaceAttachment,
  getGithubWorkItemWorkspaceAttachmentLabel,
  getGithubPrWorkspaceAttachmentLabel
} from './github-work-item-workspace-attachment'
import type { Worktree } from '../../../shared/types'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/workspace-attachment',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'GitHub workspace',
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

describe('GitHub work-item workspace attachment', () => {
  it('finds the first non-archived workspace linked to the repo PR', () => {
    const first = worktree({ id: 'first', linkedPR: 42 })
    const second = worktree({ id: 'second', linkedPR: 42 })

    expect(findGithubPrWorkspaceAttachment([first, second], 'repo-1', 42)).toBe(first)
  })

  it('finds the first non-archived workspace linked to the repo issue', () => {
    const first = worktree({ id: 'first', linkedIssue: 42 })
    const second = worktree({ id: 'second', linkedIssue: 42 })

    expect(findGithubIssueWorkspaceAttachment([first, second], 'repo-1', 42)).toBe(first)
  })

  it('matches PRs and issues through the generic helper', () => {
    const pr = worktree({ id: 'pr', linkedPR: 42 })
    const issue = worktree({ id: 'issue', linkedIssue: 42 })

    expect(findGithubWorkItemWorkspaceAttachment([issue, pr], 'repo-1', 'pr', 42)).toBe(pr)
    expect(findGithubWorkItemWorkspaceAttachment([pr, issue], 'repo-1', 'issue', 42)).toBe(issue)
  })

  it('does not match workspaces from a different repo', () => {
    const attachedElsewhere = worktree({ repoId: 'repo-2', linkedIssue: 42, linkedPR: 42 })

    expect(findGithubPrWorkspaceAttachment([attachedElsewhere], 'repo-1', 42)).toBeNull()
    expect(findGithubIssueWorkspaceAttachment([attachedElsewhere], 'repo-1', 42)).toBeNull()
  })

  it('does not match archived workspaces', () => {
    const archived = worktree({ linkedIssue: 42, linkedPR: 42, isArchived: true })

    expect(findGithubPrWorkspaceAttachment([archived], 'repo-1', 42)).toBeNull()
    expect(findGithubIssueWorkspaceAttachment([archived], 'repo-1', 42)).toBeNull()
  })

  it('returns null when no repo ID is available', () => {
    const attached = worktree({ linkedIssue: 42, linkedPR: 42 })

    expect(findGithubPrWorkspaceAttachment([attached], null, 42)).toBeNull()
    expect(findGithubIssueWorkspaceAttachment([attached], undefined, 42)).toBeNull()
  })

  it('does not cross-match PR and issue slots with the same number', () => {
    const prOnly = worktree({ id: 'pr', linkedPR: 42 })
    const issueOnly = worktree({ id: 'issue', linkedIssue: 42 })

    expect(findGithubIssueWorkspaceAttachment([prOnly], 'repo-1', 42)).toBeNull()
    expect(findGithubPrWorkspaceAttachment([issueOnly], 'repo-1', 42)).toBeNull()
  })

  it('does not treat GitLab metadata as a GitHub work-item attachment', () => {
    const gitlabOnly = worktree({
      linkedIssue: null,
      linkedPR: null,
      linkedGitLabIssue: 42,
      linkedGitLabMR: 42
    })

    expect(findGithubPrWorkspaceAttachment([gitlabOnly], 'repo-1', 42)).toBeNull()
    expect(findGithubIssueWorkspaceAttachment([gitlabOnly], 'repo-1', 42)).toBeNull()
  })

  it('labels attachments without exposing a full path when display or branch is available', () => {
    expect(
      getGithubWorkItemWorkspaceAttachmentLabel(worktree({ displayName: '  Named GH  ' }))
    ).toBe('Named GH')
    expect(
      getGithubWorkItemWorkspaceAttachmentLabel(
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
