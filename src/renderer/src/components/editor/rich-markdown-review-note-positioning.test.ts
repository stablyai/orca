// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

// Paragraphs serialize with a blank separator line, like real markdown, so with
// three paragraphs the blocks cover source lines 1, 3 and 5 and lines 2 and 4 are gaps.
// Each block starts at document position (index * 10) + 1.
function makeEditor(paragraphCount: number): Editor {
  const content = Array.from({ length: paragraphCount }, (_value, index) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: `paragraph ${index}` }]
  }))
  const doc = {
    forEach(callback: (node: unknown, offset: number, index: number) => void): void {
      content.forEach((_node, index) => callback({ nodeSize: 10 }, index * 10, index))
    },
    nodesBetween(): void {},
    content: { size: paragraphCount * 10 }
  }
  return {
    getJSON: () => ({ content }),
    state: { doc },
    markdown: {
      serialize: (value: { content?: unknown[] }) =>
        (value.content ?? []).map((_node, index) => `line ${index}`).join('\n\n')
    },
    // Why: the card top is the anchored position's y, so the top tells which block a
    // note landed on: block 0 → 1, block 1 → 11, block 2 → 21.
    view: { coordsAtPos: (pos: number) => ({ top: pos }) }
  } as unknown as Editor
}

function makeComment(id: string, lineNumber: number): DiffComment {
  return {
    id,
    worktreeId: 'wt1',
    filePath: 'NOTES.md',
    source: 'markdown',
    lineNumber,
    body: 'note',
    createdAt: 1,
    side: 'modified'
  }
}

function topOf(lineNumber: number): number | undefined {
  const positions = measureRichMarkdownReviewNotePositions({
    container: document.createElement('div'),
    editor: makeEditor(3),
    markdownComments: [makeComment('note', lineNumber)],
    markdownSourceLineOffset: 0
  })
  return positions[0]?.top
}

describe('measureRichMarkdownReviewNotePositions', () => {
  it('anchors an in-range note to its own block', () => {
    expect(topOf(1)).toBe(1)
    expect(topOf(3)).toBe(11)
    expect(topOf(5)).toBe(21)
  })

  it('anchors a note on a separator line to the block just above it', () => {
    expect(topOf(2)).toBe(1)
    expect(topOf(4)).toBe(11)
  })

  it('keeps a note whose line fell past the end after the document shrank', () => {
    expect(topOf(9)).toBe(21)

    const positions = measureRichMarkdownReviewNotePositions({
      container: document.createElement('div'),
      editor: makeEditor(3),
      markdownComments: [makeComment('past-end', 9), makeComment('inside', 3)],
      markdownSourceLineOffset: 0
    })
    expect(positions.map((position) => position.comment.id)).toEqual(['inside', 'past-end'])
  })
})
