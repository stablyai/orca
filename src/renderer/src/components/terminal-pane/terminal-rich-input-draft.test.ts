import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTerminalRichInputDraftsForTests,
  readTerminalRichInputDraft,
  readTerminalRichInputDraftContent,
  writeTerminalRichInputDraft
} from './terminal-rich-input-draft'

describe('terminal rich input drafts', () => {
  beforeEach(() => clearTerminalRichInputDraftsForTests())

  it('keeps independent drafts for stable terminal leaves', () => {
    writeTerminalRichInputDraft('tab-1:leaf-a', 'first')
    writeTerminalRichInputDraft('tab-1:leaf-b', 'second')

    expect(readTerminalRichInputDraft('tab-1:leaf-a')).toBe('first')
    expect(readTerminalRichInputDraft('tab-1:leaf-b')).toBe('second')
  })

  it('restores inline attachment positions with the text draft', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Fix this → ' },
            {
              type: 'terminalImageAttachment',
              attrs: { id: 'image-1', path: '/tmp/image.png' }
            }
          ]
        }
      ]
    }

    writeTerminalRichInputDraft('tab-1:leaf-a', 'Fix this → ', content)

    expect(readTerminalRichInputDraftContent('tab-1:leaf-a')).toEqual(content)
  })

  it('keeps an image-only draft when text is empty', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'terminalImageAttachment',
              attrs: { id: 'image-1', path: '/tmp/image.png' }
            }
          ]
        }
      ]
    }

    writeTerminalRichInputDraft('tab-1:leaf-a', '', content)

    expect(readTerminalRichInputDraftContent('tab-1:leaf-a')).toEqual(content)
  })

  it('evicts the least recently used draft past the bound', () => {
    for (let index = 0; index < 128; index += 1) {
      writeTerminalRichInputDraft(`tab-1:leaf-${index}`, `draft-${index}`)
    }
    expect(readTerminalRichInputDraft('tab-1:leaf-0')).toBe('draft-0')

    writeTerminalRichInputDraft('tab-1:leaf-128', 'draft-128')

    expect(readTerminalRichInputDraft('tab-1:leaf-0')).toBe('draft-0')
    expect(readTerminalRichInputDraft('tab-1:leaf-1')).toBe('')
  })

  it('drops an empty draft', () => {
    writeTerminalRichInputDraft('tab-1:leaf-a', 'first')
    writeTerminalRichInputDraft('tab-1:leaf-a', '')

    expect(readTerminalRichInputDraft('tab-1:leaf-a')).toBe('')
    expect(readTerminalRichInputDraftContent('tab-1:leaf-a')).toBeNull()
  })
})
