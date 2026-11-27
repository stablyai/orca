import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceAttachment } from './workspace-attachment-normalization'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'

describe("It's a Plan linked items", () => {
  it("keeps an It's a Plan linked item", () => {
    const item = {
      provider: 'itsaplan',
      type: 'issue',
      number: 42,
      title: 'ENG-42 Fix login',
      url: 'https://plan.example.com/issue/678'
    }

    expect(normalizeWorkspaceLinkedItem(item)).toEqual(item)
  })

  it("keeps an It's a Plan attachment", () => {
    const attachment = {
      provider: 'itsaplan',
      type: 'issue',
      number: 42,
      identifier: 'ENG-42',
      title: 'Fix login',
      url: 'https://plan.example.com/issue/678'
    }

    expect(normalizeWorkspaceAttachment(attachment)).toEqual(attachment)
  })
})
