import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import { matchesWorkspaceAttachmentQuery } from './workspace-attachment-source-result'

function clickupItem(
  clickupIdentifier: string,
  url: string,
  workspaceId?: string
): WorkspaceAttachment {
  return {
    provider: 'clickup',
    type: 'issue',
    number: 0,
    clickupIdentifier,
    url,
    ...(workspaceId
      ? {
          taskSourceContext: {
            kind: 'task-source',
            provider: 'clickup',
            projectId: 'p1',
            hostId: 'local',
            providerIdentity: { provider: 'clickup', workspaceId }
          }
        }
      : {})
  }
}

describe('matchesWorkspaceAttachmentQuery for ClickUp', () => {
  const fetchedRow = clickupItem('ENG-7', 'https://app.clickup.com/t/86abc123', '9001')

  it('resolves a custom-id URL query to the fetched task row', () => {
    const query = clickupItem('ENG-7', 'https://app.clickup.com/t/9001/ENG-7')
    expect(matchesWorkspaceAttachmentQuery(query, fetchedRow)).toBe(true)
  })

  it('resolves a bare custom id and a raw-id URL query to the same row', () => {
    expect(matchesWorkspaceAttachmentQuery(clickupItem('ENG-7', ''), fetchedRow)).toBe(true)
    expect(
      matchesWorkspaceAttachmentQuery(
        clickupItem('86abc123', 'https://app.clickup.com/t/86abc123'),
        fetchedRow
      )
    ).toBe(true)
  })

  it('rejects a custom-id URL scoped to another Workspace or naming another task', () => {
    expect(
      matchesWorkspaceAttachmentQuery(
        clickupItem('ENG-7', 'https://app.clickup.com/t/9002/ENG-7'),
        fetchedRow
      )
    ).toBe(false)
    expect(
      matchesWorkspaceAttachmentQuery(
        clickupItem('ENG-8', 'https://app.clickup.com/t/9001/ENG-8'),
        fetchedRow
      )
    ).toBe(false)
  })
})

describe('matchesWorkspaceAttachmentQuery for other providers', () => {
  it('still requires the same URL scope', () => {
    const linear = (url: string): WorkspaceAttachment => ({
      provider: 'linear',
      type: 'issue',
      number: 0,
      linearIdentifier: 'ENG-7',
      url
    })
    expect(
      matchesWorkspaceAttachmentQuery(
        linear('https://linear.app/acme/issue/ENG-7'),
        linear('https://linear.app/acme/issue/ENG-7/title')
      )
    ).toBe(true)
    expect(
      matchesWorkspaceAttachmentQuery(
        linear('https://linear.app/acme/issue/ENG-7'),
        linear('https://linear.app/other/issue/ENG-7')
      )
    ).toBe(false)
  })
})
