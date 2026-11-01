import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'

import { findRichMarkdownSelectedTextRanges } from './rich-markdown-review-text-ranges'

type FakeTextNode = {
  isText: true
  text: string
  size?: number
}

function editorWithTextNodes(nodes: FakeTextNode[], contentSize?: number): Editor {
  return {
    state: {
      doc: {
        content: {
          size: contentSize ?? nodes.reduce((total, node) => total + node.text.length, 0)
        },
        nodesBetween(
          _from: number,
          _to: number,
          callback: (node: FakeTextNode, pos: number) => void
        ) {
          let pos = 0
          for (const node of nodes) {
            callback(node, pos)
            pos += node.size ?? node.text.length
          }
        }
      }
    }
  } as unknown as Editor
}

describe('findRichMarkdownSelectedTextRanges', () => {
  it('matches after overlapping prefix fallback', () => {
    const editor = editorWithTextNodes([{ isText: true, text: 'xxabababaca' }])

    expect(findRichMarkdownSelectedTextRanges({ editor, selectedText: 'ababaca' })).toEqual([
      { from: 4, to: 11 }
    ])
  })

  it('stops reading later text nodes after the selected text is found', () => {
    const unreadNode = { isText: true, size: 10 } as FakeTextNode
    Object.defineProperty(unreadNode, 'text', {
      get() {
        throw new Error('later text nodes should not be read after a match')
      }
    })
    const editor = editorWithTextNodes([{ isText: true, text: 'target text' }, unreadNode], 30)

    expect(findRichMarkdownSelectedTextRanges({ editor, selectedText: 'target text' })).toEqual([
      { from: 0, to: 11 }
    ])
  })
})
