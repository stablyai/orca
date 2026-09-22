import { describe, expect, it } from 'vitest'

import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeAttachmentLabel } from './worktree-attachment-label'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/workspace-attachment',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace',
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

describe('getWorktreeAttachmentLabel', () => {
  it('prefers a trimmed display name', () => {
    expect(getWorktreeAttachmentLabel(worktree({ displayName: '  Named workspace  ' }))).toBe(
      'Named workspace'
    )
  })

  it('falls back to a branch without the local ref prefix', () => {
    expect(
      getWorktreeAttachmentLabel(worktree({ displayName: '', branch: 'refs/heads/fix-ci' }))
    ).toBe('fix-ci')
  })

  it('falls back to the cross-platform path basename', () => {
    expect(
      getWorktreeAttachmentLabel(
        worktree({ displayName: '', branch: '', path: 'C:\\repo\\workspace-tail' })
      )
    ).toBe('workspace-tail')
  })
})
