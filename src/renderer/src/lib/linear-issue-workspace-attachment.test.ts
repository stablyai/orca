import { describe, expect, it } from 'vitest'

import {
  buildLinearIssueWorkspaceAttachmentIndex,
  findLinearIssueWorkspaceAttachmentInIndex
} from './linear-issue-workspace-attachment'
import type { Worktree } from '../../../shared/worktree/types'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/linear-attachment',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'Linear workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: overrides.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: overrides.linkedLinearIssueWorkspaceId,
    linkedLinearIssueOrganizationUrlKey: overrides.linkedLinearIssueOrganizationUrlKey,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('multiple Linear attachments', () => {
  it('indexes secondary identifiers and keeps organization scope', () => {
    const attached = worktree({
      linkedLinearIssue: 'STA-1',
      linkedItems: [
        {
          provider: 'linear',
          type: 'issue',
          number: 0,
          identifier: 'STA-2',
          linearOrganizationUrlKey: 'acme'
        }
      ]
    })
    const index = buildLinearIssueWorkspaceAttachmentIndex([attached])
    expect(
      findLinearIssueWorkspaceAttachmentInIndex(index, {
        identifier: 'STA-2',
        url: 'https://linear.app/acme/issue/STA-2'
      })
    ).toBe(attached)
    expect(
      findLinearIssueWorkspaceAttachmentInIndex(index, {
        identifier: 'STA-2',
        url: 'https://linear.app/other/issue/STA-2'
      })
    ).toBeNull()
  })
})
