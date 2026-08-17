import { describe, expect, it } from 'vitest'

import {
  buildLinearIssueWorkspaceAttachmentIndex,
  findLinearIssueWorkspaceAttachment,
  findLinearIssueWorkspaceAttachmentInIndex,
  getLinearIssueWorkspaceAttachmentLabel
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

describe('Linear issue workspace attachment', () => {
  it('finds the first non-archived workspace linked to the issue identifier', () => {
    const first = worktree({ id: 'first', linkedLinearIssue: 'STA-2716' })
    const second = worktree({ id: 'second', linkedLinearIssue: 'STA-2716' })

    expect(findLinearIssueWorkspaceAttachment([first, second], { identifier: 'STA-2716' })).toBe(
      first
    )
  })

  it('prefers the most recently active workspace when multiple exact links exist', () => {
    const older = worktree({
      id: 'older',
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: 'ws-a',
      lastActivityAt: 10
    })
    const newer = worktree({
      id: 'newer',
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: 'ws-a',
      lastActivityAt: 20
    })

    expect(
      findLinearIssueWorkspaceAttachment([older, newer], {
        identifier: 'STA-2716',
        workspaceId: 'ws-a'
      })
    ).toBe(newer)
  })

  it('matches identifiers case-insensitively and from Linear URLs', () => {
    const attached = worktree({
      linkedLinearIssue: 'https://linear.app/stably/issue/sta-2716/title'
    })

    expect(
      findLinearIssueWorkspaceAttachment([attached], {
        identifier: 'sta-2716',
        url: 'https://linear.app/stably/issue/STA-2716/title'
      })
    ).toBe(attached)
  })

  it('does not match archived workspaces', () => {
    const archived = worktree({ linkedLinearIssue: 'STA-2716', isArchived: true })

    expect(findLinearIssueWorkspaceAttachment([archived], { identifier: 'STA-2716' })).toBeNull()
  })

  it('does not match a different Linear identifier', () => {
    const other = worktree({ linkedLinearIssue: 'STA-1' })

    expect(findLinearIssueWorkspaceAttachment([other], { identifier: 'STA-2716' })).toBeNull()
  })

  it('refuses cross-workspace matches when both sides declare a workspace id', () => {
    const otherWorkspace = worktree({
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: 'ws-a'
    })

    expect(
      findLinearIssueWorkspaceAttachment([otherWorkspace], {
        identifier: 'STA-2716',
        workspaceId: 'ws-b'
      })
    ).toBeNull()
  })

  it('matches when only one side has a workspace id', () => {
    const unscoped = worktree({
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: null
    })
    const scoped = worktree({
      id: 'scoped',
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: 'ws-a'
    })

    expect(
      findLinearIssueWorkspaceAttachment([unscoped], {
        identifier: 'STA-2716',
        workspaceId: 'ws-a'
      })
    ).toBe(unscoped)
    expect(
      findLinearIssueWorkspaceAttachment([scoped], {
        identifier: 'STA-2716'
      })
    ).toBe(scoped)
  })

  it('prefers an exact workspace match over an earlier unscoped legacy link', () => {
    const legacy = worktree({ linkedLinearIssue: 'STA-2716', linkedLinearIssueWorkspaceId: null })
    const exact = worktree({
      id: 'exact',
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueWorkspaceId: 'ws-a'
    })

    expect(
      findLinearIssueWorkspaceAttachment([legacy, exact], {
        identifier: 'STA-2716',
        workspaceId: 'ws-a'
      })
    ).toBe(exact)
  })

  it('refuses cross-org matches when both sides declare an organization key', () => {
    const otherOrg = worktree({
      linkedLinearIssue: 'STA-2716',
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })

    expect(
      findLinearIssueWorkspaceAttachment([otherOrg], {
        identifier: 'STA-2716',
        url: 'https://linear.app/stably/issue/STA-2716/title'
      })
    ).toBeNull()
  })

  it('resolves the same worktree through the row index as through a linear scan', () => {
    const worktrees = [
      worktree({ id: 'archived', linkedLinearIssue: 'STA-2716', isArchived: true }),
      worktree({
        id: 'other-org',
        linkedLinearIssue: 'STA-2716',
        linkedLinearIssueOrganizationUrlKey: 'acme'
      }),
      worktree({ id: 'match', linkedLinearIssue: 'sta-2716' }),
      worktree({ id: 'unrelated', linkedLinearIssue: 'STA-1' })
    ]
    const index = buildLinearIssueWorkspaceAttachmentIndex(worktrees)
    const issue = {
      identifier: 'STA-2716',
      url: 'https://linear.app/stably/issue/STA-2716/title'
    }

    expect(findLinearIssueWorkspaceAttachmentInIndex(index, issue)).toBe(
      findLinearIssueWorkspaceAttachment(worktrees, issue)
    )
    expect(findLinearIssueWorkspaceAttachmentInIndex(index, issue)?.id).toBe('match')
    expect(findLinearIssueWorkspaceAttachmentInIndex(index, { identifier: 'STA-9999' })).toBeNull()
  })

  it('labels attachments without exposing a full path when display or branch is available', () => {
    expect(
      getLinearIssueWorkspaceAttachmentLabel(worktree({ displayName: '  Named Linear  ' }))
    ).toBe('Named Linear')
    expect(
      getLinearIssueWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: 'refs/heads/fix-ci' })
      )
    ).toBe('fix-ci')
    expect(
      getLinearIssueWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: '', path: 'C:\\repo\\workspace-tail' })
      )
    ).toBe('workspace-tail')
  })
})
