import { getSchema } from '@tiptap/core'
import { Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import {
  NativeChatFileReference,
  NativeChatSkill,
  promptLeafText,
  promptText,
  promptTextOffset,
  promptTextPosition
} from './native-chat-prompt-document'

const schema = getSchema([StarterKit, NativeChatSkill, NativeChatFileReference])

function documentWithAtoms(): ProseMirrorNode {
  return schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a😀' },
          { type: 'nativeChatSkill', attrs: { token: '$rev' } },
          { type: 'hardBreak' },
          { type: 'text', text: 'b' }
        ]
      },
      {
        type: 'paragraph',
        content: [
          { type: 'nativeChatFileReference', attrs: { token: '@f', path: '/f' } },
          { type: 'nativeChatSkill', attrs: { token: '$x' } }
        ]
      },
      { type: 'paragraph' }
    ]
  })
}

// The per-character map the composer used to rebuild on every read: the behaviour these reads keep.
function characterPositions(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = ''
  const positions = [1]
  doc.forEach((block, blockOffset, index) => {
    if (index > 0) {
      text += '\n'
      positions.push(blockOffset + 1)
    }
    block.forEach((node, offset) => {
      const start = blockOffset + 1 + offset
      const value = node.text ?? promptLeafText(node)
      for (let i = 0; i < value.length; i++) {
        text += value[i]
        positions.push(
          node.isText ? start + i + 1 : i === value.length - 1 ? start + node.nodeSize : start
        )
      }
    })
  })
  return { text, positions }
}

/** Text carets and paragraph node selections, including positions between paragraphs. */
function selectablePositions(doc: ProseMirrorNode): number[] {
  const positions = [0, doc.content.size]
  doc.forEach((block, blockOffset) => {
    const selection = NodeSelection.create(doc, blockOffset)
    positions.push(selection.from, selection.to)
    for (
      let position = blockOffset + 1;
      position <= blockOffset + 1 + block.content.size;
      position++
    ) {
      positions.push(position)
    }
  })
  return positions
}

describe('prompt document reads', () => {
  it('reads UTF-16 units, pills, hard breaks and paragraphs as the agent receives them', () => {
    const doc = documentWithAtoms()
    expect(promptText(doc)).toBe('a😀$rev\nb\n@f$x\n')
    expect(promptText(doc)).toBe(characterPositions(doc).text)
  })

  it('finds the same caret as the per-character map for every selectable position', () => {
    const doc = documentWithAtoms()
    const { positions } = characterPositions(doc)
    for (const position of selectablePositions(doc)) {
      const index = positions.findIndex((candidate) => candidate >= position)
      expect(promptTextOffset(doc, position)).toBe(index === -1 ? positions.length - 1 : index)
    }
  })

  it('finds the same position as the per-character map for every caret, inside pills too', () => {
    const doc = documentWithAtoms()
    const { positions } = characterPositions(doc)
    for (let offset = 0; offset < positions.length + 3; offset++) {
      expect(promptTextPosition(doc, offset)).toBe(
        positions[Math.min(offset, positions.length - 1)]
      )
    }
  })

  it('widens a caret inside a pill to the whole pill on the requested side', () => {
    const doc = documentWithAtoms()
    // 'a😀' is 3 units, so offsets 4-6 sit inside `$rev`, which starts at document position 4.
    for (const offset of [4, 5, 6]) {
      expect(promptTextPosition(doc, offset, 'before')).toBe(4)
      expect(promptTextPosition(doc, offset, 'after')).toBe(5)
    }
    expect(promptTextOffset(doc, 4)).toBe(3)
    expect(promptTextOffset(doc, 5)).toBe(7)
    // Off a pill, both sides agree.
    expect(promptTextPosition(doc, 3, 'after')).toBe(promptTextPosition(doc, 3, 'before'))
    expect(promptTextPosition(doc, 7, 'after')).toBe(promptTextPosition(doc, 7, 'before'))
  })

  it('reads an edited document from its own content', () => {
    const doc = documentWithAtoms()
    const edited = doc.replace(1, 2, Slice.empty)
    expect(promptText(edited)).toBe('😀$rev\nb\n@f$x\n')
    expect(promptText(doc)).toBe('a😀$rev\nb\n@f$x\n')
  })

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
