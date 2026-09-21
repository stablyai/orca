// @vitest-environment happy-dom
// Run: ORCA_REVIEW_RAIL_BENCH=1 pnpm test src/renderer/src/components/editor/rich-markdown-review-rail-benchmark.test.ts
import { expect, it, vi } from 'vitest'
import { Editor as TiptapEditor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

// Baseline measurement body from the parent revision, before sharing source blocks.
import type { Editor } from '@tiptap/react'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentAnchorTop
} from './rich-markdown-review-annotations'
import {
  stackRichMarkdownReviewNotePositions,
  type RichMarkdownReviewNotePosition
} from './rich-markdown-review-note-layout'

type MeasureRichMarkdownReviewNotePositionsOptions = {
  container: HTMLDivElement
  editor: Editor
  markdownComments: DiffComment[]
  markdownSourceLineOffset: number
}

function measureBaseline({
  container,
  editor,
  markdownComments,
  markdownSourceLineOffset
}: MeasureRichMarkdownReviewNotePositionsOptions): RichMarkdownReviewNotePosition[] {
  const containerRect = container.getBoundingClientRect()
  const blocks = buildRichMarkdownCommentBlocks(editor)
  const nextPositions = markdownComments
    .map((comment): RichMarkdownReviewNotePosition | null => {
      const bodyLineNumber = Math.max(1, comment.lineNumber - markdownSourceLineOffset)
      const block = blocks.find(
        (candidate) => candidate.startLine <= bodyLineNumber && bodyLineNumber <= candidate.endLine
      )
      if (!block) {
        return null
      }
      const top = getRichMarkdownCommentAnchorTop(
        editor,
        comment,
        block,
        containerRect,
        container.scrollTop,
        markdownSourceLineOffset
      )
      return top === null ? null : { comment, top }
    })
    .filter((position): position is RichMarkdownReviewNotePosition => position !== null)
  return stackRichMarkdownReviewNotePositions(
    nextPositions,
    measureReviewNoteHeights(container, nextPositions)
  )
}

function measureReviewNoteHeights(
  container: HTMLDivElement,
  positions: RichMarkdownReviewNotePosition[]
): Map<string, number> {
  const measuredHeights = new Map<string, number>()
  for (const pos of positions) {
    const el = container.querySelector(`[data-rich-markdown-review-note-id="${pos.comment.id}"]`)
    if (el) {
      measuredHeights.set(pos.comment.id, el.getBoundingClientRect().height)
    }
  }
  return measuredHeights
}

it.skipIf(process.env.ORCA_REVIEW_RAIL_BENCH !== '1')(
  'benchmarks full review rail measurements',
  () => {
    for (const blockCount of [250, 1000]) {
      const editor = new TiptapEditor({
        element: document.createElement('div'),
        extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
        content: {
          type: 'doc',
          content: Array.from({ length: blockCount }, (_, index) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: `Paragraph ${index} with reviewable content.` }]
          }))
        }
      })
      try {
        vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
          top: 100,
          bottom: 120,
          left: 0,
          right: 10
        })
        const container = document.createElement('div')
        const markdownComments: DiffComment[] = Array.from({ length: 5 }, (_, index) => ({
          id: `note-${index}`,
          worktreeId: 'workspace',
          filePath: 'notes.md',
          source: 'markdown',
          lineNumber: 1 + index * 40,
          body: 'Review',
          createdAt: index,
          side: 'modified'
        }))
        const args = { editor, container, markdownComments, markdownSourceLineOffset: 0 }
        const serialize = vi.spyOn(editor.markdown!, 'serialize')
        const baseline = measureBaseline(args)
        const baselineCalls = serialize.mock.calls.length
        serialize.mockClear()
        expect(measureRichMarkdownReviewNotePositions(args)).toEqual(baseline)
        const coldCalls = serialize.mock.calls.length
        serialize.mockClear()
        expect(measureRichMarkdownReviewNotePositions(args)).toEqual(baseline)
        const warmCalls = serialize.mock.calls.length
        serialize.mockRestore()
        const time = (run: () => unknown) => {
          const start = performance.now()
          for (let index = 0; index < 20; index++) {
            run()
          }
          return (performance.now() - start) / 20
        }
        const before: number[] = []
        const after: number[] = []
        for (let round = 0; round < 5; round++) {
          before.push(time(() => measureBaseline(args)))
          after.push(time(() => measureRichMarkdownReviewNotePositions(args)))
        }
        const median = (values: number[]) => values.sort((a, b) => a - b)[2]!
        const result = {
          blockCount,
          comments: markdownComments.length,
          beforeMs: median(before),
          afterMs: median(after),
          baselineCalls,
          coldCalls,
          warmCalls
        }
        process.stdout.write(`${JSON.stringify(result)}\n`)
        expect(baselineCalls).toBe((2 * blockCount - 1) * 6)
        expect(coldCalls).toBe(2 * blockCount - 1)
        expect(warmCalls).toBe(0)
      } finally {
        editor.destroy()
        vi.restoreAllMocks()
      }
    }
  },
  120_000
)
