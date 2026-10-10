import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import {
  countRichMarkdownReviewMarkdownLines,
  getRichMarkdownAnnotationButtonLeft,
  getRichMarkdownAnnotationButtonTop,
  getRichMarkdownAnnotationHighlightRanges,
  getRichMarkdownCommentAtPos
} from './rich-markdown-review-annotations'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('countRichMarkdownReviewMarkdownLines', () => {
  it('counts LF, CRLF, and CR line endings exactly', () => {
    expect(countRichMarkdownReviewMarkdownLines('')).toBe(1)
    expect(countRichMarkdownReviewMarkdownLines('one')).toBe(1)
    expect(countRichMarkdownReviewMarkdownLines('one\ntwo')).toBe(2)
    expect(countRichMarkdownReviewMarkdownLines('one\r\ntwo\r\nthree')).toBe(3)
    expect(countRichMarkdownReviewMarkdownLines('one\rtwo')).toBe(2)
  })

  it('counts large pasted markdown blocks without splitting into line arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const text = 'line\r\n'.repeat(100_000)

    expect(countRichMarkdownReviewMarkdownLines(text)).toBe(100_001)

    expect(split).not.toHaveBeenCalled()
  })
})

describe('getRichMarkdownAnnotationButtonTop', () => {
  it('keeps the add-note button below short visible selections', () => {
    expect(getRichMarkdownAnnotationButtonTop(120, 500)).toBe(128)
  })

  it('clamps the add-note button inside the visible editor shell for long selections', () => {
    expect(getRichMarkdownAnnotationButtonTop(760, 500)).toBe(468)
  })
})

describe('getRichMarkdownAnnotationButtonLeft', () => {
  it('keeps the add-note button near the right edge when there is room', () => {
    expect(getRichMarkdownAnnotationButtonLeft(700)).toBe(658)
  })

  it('clamps the add-note button inside narrow editor shells', () => {
    expect(getRichMarkdownAnnotationButtonLeft(72)).toBe(40)
  })
})

// Why count serializes: resolving a comment's block re-serializes the document,
// so doing it per comment made these O(comments x document). A call count is
// deterministic where a wall-clock threshold would be flaky.
describe('rich markdown annotation block reuse', () => {
  function makeEditor(nodeCount: number): { editor: Editor; serializeCalls: () => number } {
    let serializeCalls = 0
    const content = Array.from({ length: nodeCount }, (_value, index) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `paragraph ${index}` }]
    }))
    const doc = {
      forEach(callback: (node: unknown, offset: number, index: number) => void): void {
        content.forEach((node, index) => callback(node, index * 10, index))
      },
      // The text-range search walks the doc to locate the selected text; these
      // fixtures never match, so it only needs to be traversable.
      nodesBetween(): void {},
      content: { size: nodeCount * 10 }
    }
    const editor = {
      getJSON: () => ({ content }),
      state: { doc },
      markdown: {
        serialize: (value: { content?: unknown[] }) => {
          serializeCalls += 1
          return (value.content ?? []).map((_node, index) => `line ${index}`).join('\n')
        }
      }
    } as unknown as Editor
    return { editor, serializeCalls: () => serializeCalls }
  }

  function makeComments(count: number): DiffComment[] {
    return Array.from(
      { length: count },
      (_value, index) => ({ lineNumber: index + 1, selectedText: 'nothing-matches' }) as DiffComment
    )
  }

  // One block build over NODE_COUNT nodes: each node serialized alone, plus each
  // adjacent pair. Pinned absolutely so "both arms build twice" can't pass as equal.
  const NODE_COUNT = 12
  const ONE_BUILD_SERIALIZE_CALLS = NODE_COUNT + (NODE_COUNT - 1)

  it('serializes the document once regardless of comment count', () => {
    const single = makeEditor(NODE_COUNT)
    getRichMarkdownAnnotationHighlightRanges(single.editor, makeComments(1), 0)

    const many = makeEditor(NODE_COUNT)
    getRichMarkdownAnnotationHighlightRanges(many.editor, makeComments(8), 0)

    expect(single.serializeCalls()).toBe(ONE_BUILD_SERIALIZE_CALLS)
    expect(many.serializeCalls()).toBe(ONE_BUILD_SERIALIZE_CALLS)
  })

  it('serializes the document once when locating the comment at a position', () => {
    const single = makeEditor(NODE_COUNT)
    getRichMarkdownCommentAtPos(single.editor, makeComments(1), 0, 5)

    const many = makeEditor(NODE_COUNT)
    getRichMarkdownCommentAtPos(many.editor, makeComments(8), 0, 5)

    expect(single.serializeCalls()).toBe(ONE_BUILD_SERIALIZE_CALLS)
    expect(many.serializeCalls()).toBe(ONE_BUILD_SERIALIZE_CALLS)
  })

  it('does no work at all with no comments', () => {
    const none = makeEditor(12)
    expect(getRichMarkdownAnnotationHighlightRanges(none.editor, [], 0)).toEqual([])
    expect(getRichMarkdownCommentAtPos(none.editor, [], 0, 5)).toBeNull()
    expect(none.serializeCalls()).toBe(0)
  })
})
