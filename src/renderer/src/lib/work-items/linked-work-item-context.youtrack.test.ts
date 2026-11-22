import { describe, expect, it } from 'vitest'
import {
  getLaunchableWorkItemDraftContent,
  resolveQuickCreateLinkedWorkItemPrompt
} from './linked-work-item-context'

describe('YouTrack launch context', () => {
  it('names the YouTrack issue ID alongside its link', () => {
    const item = {
      provider: 'youtrack' as const,
      number: 0,
      url: 'https://yt.example.com/issue/PROJ-81',
      title: 'PROJ-81 Retry payments',
      youtrackIdentifier: 'PROJ-81'
    }
    const block = 'Linked YouTrack issue: PROJ-81\nhttps://yt.example.com/issue/PROJ-81'
    expect(getLaunchableWorkItemDraftContent(item)).toBe(`${block}\n`)
    expect(resolveQuickCreateLinkedWorkItemPrompt(item, '').draftPrompt).toBe(`${block}\n`)
  })
})
