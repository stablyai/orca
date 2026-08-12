import { describe, expect, it } from 'vitest'

import {
  findBeadsIssueWorkspaceAttachment,
  getBeadsIssueWorkspaceAttachmentLabel
} from './beads-issue-workspace-attachment'
import type { Worktree, WorkspaceLinkedItem } from '../../../shared/types'

function beadsLinkedItem(overrides: Partial<WorkspaceLinkedItem> = {}): WorkspaceLinkedItem {
  return {
    provider: 'beads',
    type: 'issue',
    number: 0,
    title: 'orca-abc123 Fix the thing',
    url: '',
    beadsIdentifier: 'orca-abc123',
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/beads-attachment',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'Beads workspace',
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

describe('Beads issue workspace attachment', () => {
  it('finds the first non-archived workspace linked to the beads issue', () => {
    const first = worktree({ id: 'first', linkedWorkItem: beadsLinkedItem() })
    const second = worktree({ id: 'second', linkedWorkItem: beadsLinkedItem() })

    expect(findBeadsIssueWorkspaceAttachment([first, second], 'repo-1', 'orca-abc123')).toBe(first)
  })

  it('does not match a different beads identifier, repo, or archived workspace', () => {
    const otherIssue = worktree({
      linkedWorkItem: beadsLinkedItem({ beadsIdentifier: 'orca-zzz999' })
    })
    const otherRepo = worktree({ repoId: 'repo-2', linkedWorkItem: beadsLinkedItem() })
    const archived = worktree({ linkedWorkItem: beadsLinkedItem(), isArchived: true })

    expect(findBeadsIssueWorkspaceAttachment([otherIssue], 'repo-1', 'orca-abc123')).toBeNull()
    expect(findBeadsIssueWorkspaceAttachment([otherRepo], 'repo-1', 'orca-abc123')).toBeNull()
    expect(findBeadsIssueWorkspaceAttachment([archived], 'repo-1', 'orca-abc123')).toBeNull()
  })

  it('does not treat other providers or GitHub number slots as beads attachments', () => {
    const linearLinked = worktree({
      linkedWorkItem: beadsLinkedItem({ provider: 'linear', beadsIdentifier: undefined })
    })
    const githubNumbered = worktree({ linkedIssue: 42, linkedWorkItem: null })

    expect(findBeadsIssueWorkspaceAttachment([linearLinked], 'repo-1', 'orca-abc123')).toBeNull()
    expect(findBeadsIssueWorkspaceAttachment([githubNumbered], 'repo-1', 'orca-abc123')).toBeNull()
  })

  it('returns null when no repo ID is available', () => {
    const attached = worktree({ linkedWorkItem: beadsLinkedItem() })

    expect(findBeadsIssueWorkspaceAttachment([attached], null, 'orca-abc123')).toBeNull()
    expect(findBeadsIssueWorkspaceAttachment([attached], undefined, 'orca-abc123')).toBeNull()
  })

  it('labels attachments from display name or branch', () => {
    expect(getBeadsIssueWorkspaceAttachmentLabel(worktree({ displayName: '  Named WS  ' }))).toBe(
      'Named WS'
    )
    expect(
      getBeadsIssueWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: 'refs/heads/fix-ci' })
      )
    ).toBe('fix-ci')
  })
})
