import { describe, expect, it } from 'vitest'

import {
  findOdooTicketWorkspaceAttachment,
  getOdooTicketWorkspaceAttachmentLabel
} from './odoo-ticket-workspace-attachment'
import type { Worktree } from '../../../shared/worktree/types'
function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/odoo-ticket-42',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'Odoo workspace',
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

describe('findOdooTicketWorkspaceAttachment', () => {
  it('finds the workspace linked to the ticket on the matching instance', () => {
    const attached = worktree({ linkedOdooTicket: 42, linkedOdooInstanceId: 'instance-1' })

    expect(findOdooTicketWorkspaceAttachment([attached], 42, 'instance-1')).toBe(attached)
  })

  it('does not match the same ticket id on a different instance', () => {
    const attached = worktree({ linkedOdooTicket: 42, linkedOdooInstanceId: 'instance-1' })

    expect(findOdooTicketWorkspaceAttachment([attached], 42, 'instance-2')).toBeNull()
  })

  it('treats missing instance ids on both sides as a match', () => {
    const attached = worktree({ linkedOdooTicket: 42, linkedOdooInstanceId: null })

    expect(findOdooTicketWorkspaceAttachment([attached], 42, null)).toBe(attached)
    expect(findOdooTicketWorkspaceAttachment([attached], 42, undefined)).toBe(attached)
  })

  it('does not match archived workspaces', () => {
    const archived = worktree({
      linkedOdooTicket: 42,
      linkedOdooInstanceId: null,
      isArchived: true
    })

    expect(findOdooTicketWorkspaceAttachment([archived], 42, null)).toBeNull()
  })

  it('does not match a different ticket id', () => {
    const attached = worktree({ linkedOdooTicket: 42, linkedOdooInstanceId: null })

    expect(findOdooTicketWorkspaceAttachment([attached], 7, null)).toBeNull()
  })
})

describe('getOdooTicketWorkspaceAttachmentLabel', () => {
  it('prefers the display name', () => {
    expect(getOdooTicketWorkspaceAttachmentLabel(worktree({ displayName: '  Named  ' }))).toBe(
      'Named'
    )
  })

  it('falls back to the branch name', () => {
    expect(
      getOdooTicketWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: 'refs/heads/fix-ci' })
      )
    ).toBe('fix-ci')
  })
})
