import { describe, expect, it } from 'vitest'
import { getWorkspaceAttachments } from './workspace-attachments'

describe('getWorkspaceAttachments', () => {
  it('derives a ClickUp attachment from id-only worktree links', () => {
    const attachments = getWorkspaceAttachments({
      linkedClickUpTaskId: '86abc123',
      linkedClickUpWorkspaceId: 'team-1'
    })
    expect(attachments).toEqual([
      expect.objectContaining({
        provider: 'clickup',
        clickupIdentifier: '86abc123',
        clickupWorkspaceId: 'team-1'
      })
    ])
  })
})
