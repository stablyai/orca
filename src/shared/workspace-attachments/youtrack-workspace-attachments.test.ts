import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceAttachments,
  toWorkspaceLinkedItem
} from './workspace-attachment-normalization'
import { getWorkspaceAttachments, workspaceAttachmentReferenceLabel } from './workspace-attachments'

describe('YouTrack workspace attachments', () => {
  it('retains the linked issue key across legacy metadata, canonical attachments, and projection', () => {
    const linkedWorkItem = {
      provider: 'youtrack',
      type: 'issue',
      number: 0,
      title: 'Test the migration',
      url: 'https://tracker.example.com/yt/issue/APP-42/Test-the-migration',
      youtrackIdentifier: 'APP-42'
    } as const
    const [attachment] = getWorkspaceAttachments({ linkedWorkItem })
    expect(attachment).toMatchObject({ provider: 'youtrack', identifier: 'APP-42' })
    expect(workspaceAttachmentReferenceLabel(attachment)).toBe('APP-42')
    expect(toWorkspaceLinkedItem(attachment)).toEqual(linkedWorkItem)
    expect(
      normalizeWorkspaceAttachments([
        attachment,
        { ...attachment, url: 'https://tracker.example.com/yt/issue/APP-42' },
        {
          ...attachment,
          identifier: 'APP-43',
          youtrackIdentifier: 'APP-43',
          url: 'https://tracker.example.com/yt/issue/APP-43'
        }
      ]).map((item) => item.identifier)
    ).toEqual(['APP-42', 'APP-43'])
  })
})
