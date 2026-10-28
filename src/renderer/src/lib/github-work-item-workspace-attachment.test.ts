import { describe, expect, it } from 'vitest'

import {
  findGithubIssueWorkspaceAttachment,
  findGithubPrWorkspaceAttachment
} from './github-work-item-workspace-attachment'
import type { Worktree } from '../../../shared/worktree/types'

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

  it('does not cross-match PR and issue slots with the same number', () => {
    const prOnly = worktree({ id: 'pr', linkedPR: 42 })
    const issueOnly = worktree({ id: 'issue', linkedIssue: 42 })

    expect(findGithubIssueWorkspaceAttachment([prOnly], 'repo-1', 42)).toBeNull()
    expect(findGithubPrWorkspaceAttachment([issueOnly], 'repo-1', 42)).toBeNull()
  })
})

describe('multiple GitHub attachments', () => {
  it('finds secondary reviews and issues', () => {
    const attached = worktree({
      linkedPR: 1,
      linkedIssue: 2,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 3 },
        { provider: 'github', type: 'issue', number: 4 }
      ]
    })
    expect(findGithubPrWorkspaceAttachment([attached], attached.repoId, 3)).toBe(attached)
    expect(findGithubIssueWorkspaceAttachment([attached], attached.repoId, 4)).toBe(attached)
  })
})

describe('GitHub attachment repository scope', () => {
  it('matches a foreign task by URL across workspace repositories', () => {
    const attached = worktree({
      linkedItems: [
        {
          provider: 'github',
          type: 'issue',
          number: 42,
          url: 'https://github.com/foreign/project/issues/42'
        }
      ]
    })
    expect(
      findGithubIssueWorkspaceAttachment(
        [attached],
        'foreign-repo',
        42,
        'https://github.com/foreign/project/issues/42'
      )
    ).toBe(attached)
    expect(
      findGithubIssueWorkspaceAttachment(
        [attached],
        'repo-1',
        42,
        'https://github.com/current/project/issues/42'
      )
    ).toBeNull()
  })
})
