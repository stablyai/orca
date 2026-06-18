import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'

import { MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES } from './markdown-preview-search'
import { findRichMarkdownSearchMatches } from './rich-markdown-search'

function docFromText(text: string, pos = 0): ProseMirrorNode {
  return {
    descendants(callback: (node: { isText: boolean; text?: string }, pos: number) => void) {
      callback({ isText: true, text }, pos)
    }
  } as unknown as ProseMirrorNode
}

describe('findRichMarkdownSearchMatches', () => {
  it('returns match ranges relative to ProseMirror positions', () => {
    expect(findRichMarkdownSearchMatches(docFromText('Alpha beta', 10), 'beta')).toEqual([
      { from: 16, to: 20 }
    ])
  })

  it('does not walk the document for oversized pasted search text', () => {
    const doc = {
      descendants() {
        throw new Error('oversized rich markdown search must not walk the document')
      }
    } as unknown as ProseMirrorNode

    expect(
      findRichMarkdownSearchMatches(doc, 'x'.repeat(MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES + 1))
    ).toEqual([])
  })
})
