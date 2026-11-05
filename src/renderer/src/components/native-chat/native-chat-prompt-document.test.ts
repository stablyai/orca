import { getSchema } from '@tiptap/core'

import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import {
  NativeChatFileReference,
  NativeChatSkill,
  promptText,
  promptTextOffset,
  promptTextPosition
} from './native-chat-prompt-document'

const schema = getSchema([StarterKit, NativeChatSkill, NativeChatFileReference])

describe('prompt document reads', () => {
  it('counts a paragraph node selection from the start of its serialized line', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }
      ]
    })
    const selection = NodeSelection.create(doc, 3)
    expect(promptTextOffset(doc, selection.from)).toBe(2)
    expect(promptTextOffset(doc, selection.to)).toBe(3)
  })

  it('reads a pill without a token as empty', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'nativeChatSkill', attrs: { token: '' } },
            { type: 'text', text: 'b' }
          ]
        }
      ]
    })
    expect(promptText(doc)).toBe('ab')
    expect(promptTextOffset(doc, 3)).toBe(1)
    expect(promptTextPosition(doc, 1)).toBe(2)
    expect(promptTextPosition(doc, 2)).toBe(4)
  })
})
