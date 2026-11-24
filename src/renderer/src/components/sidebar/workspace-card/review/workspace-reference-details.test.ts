import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from '../../../../../../shared/worktree/types'
import {
  clickupReferenceReadInput,
  matchesClickUpWorkspaceReference
} from './workspace-reference-details'

const task = {
  id: '86abc123',
  workspaceId: '9001',
  customId: 'ENG-7',
  url: 'https://app.clickup.com/t/86abc123'
}

function attachment(clickupIdentifier: string, url: string): WorkspaceAttachment {
  return { provider: 'clickup', type: 'issue', number: 0, clickupIdentifier, url }
}

describe('matchesClickUpWorkspaceReference', () => {
  it('accepts a custom-id reference to the fetched task, by custom-id URL or by the task URL', () => {
    expect(
      matchesClickUpWorkspaceReference(
        attachment('ENG-7', 'https://app.clickup.com/t/9001/ENG-7'),
        'ENG-7',
        task
      )
    ).toBe(true)
    expect(
      matchesClickUpWorkspaceReference(
        attachment('ENG-7', 'https://app.clickup.com/t/86abc123'),
        'ENG-7',
        task
      )
    ).toBe(true)
  })

  it('rejects a task from another Workspace that shares the custom id', () => {
    expect(
      matchesClickUpWorkspaceReference(
        attachment('ENG-7', 'https://app.clickup.com/t/9001/ENG-7'),
        'ENG-7',
        { ...task, id: '86zzz999', workspaceId: '9002' }
      )
    ).toBe(false)
  })

  it('rejects a task that neither id nor custom id names', () => {
    expect(
      matchesClickUpWorkspaceReference(
        attachment('ENG-8', 'https://app.clickup.com/t/9001/ENG-8'),
        'ENG-8',
        task
      )
    ).toBe(false)
  })
})

describe('ClickUp reference reads', () => {
  const rawUrl = 'https://app.clickup.com/t/86abc123'

  it('reads a linked task by its stored URL, not by a bare custom id the host resolves per Workspace', () => {
    const scopedUrl = 'https://app.clickup.com/t/9001/ENG-7'
    expect(clickupReferenceReadInput(attachment('ENG-7', rawUrl), 'ENG-7')).toBe(rawUrl)
    expect(clickupReferenceReadInput(attachment('ENG-7', scopedUrl), 'ENG-7')).toBe(scopedUrl)
    expect(clickupReferenceReadInput(attachment('ENG-7', ''), 'ENG-7')).toBe('ENG-7')
  })

  it('still matches the task after its custom id prefix changed', () => {
    expect(
      matchesClickUpWorkspaceReference(attachment('ENG-7', rawUrl), 'ENG-7', {
        ...task,
        customId: 'PLAT-7'
      })
    ).toBe(true)
  })
})
