import { describe, expect, it } from 'vitest'
import {
  markdownPreviewMinimumRowHeight,
  markdownPreviewRequestIndices,
  markdownPreviewViewportIndices
} from './markdown-preview-viewport-budget'
import { MarkdownPreviewDocumentEngine } from './markdown-preview-document-engine'

describe('large preview viewport budgets', () => {
  it('keeps visible rows and a composer below the viewport ahead of overscan', () => {
    const indices = markdownPreviewViewportIndices(
      { startIndex: 10, endIndex: 44, overscan: 3, count: 100 },
      90
    )
    expect(indices).toHaveLength(40)
    expect(indices).toContain(90)
    for (let index = 10; index <= 44; index += 1) {
      expect(indices).toContain(index)
    }
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('reserves enough row height for partial rows, overscan and a pinned note at any viewport size', () => {
    for (const height of [500, 1500, 8000]) {
      const minimum = markdownPreviewMinimumRowHeight(height)
      const visible = Math.ceil(height / minimum) + 2
      expect(visible + 6 + 1).toBeLessThanOrEqual(40)
    }
  })

  it('makes Find targets revealable even when surrounding blocks exhaust the node budget', async () => {
    const engine = new MarkdownPreviewDocumentEngine()
    engine.load(
      Array.from(
        { length: 20 },
        (_, index) => `| a | b |\n| --- | --- |\n${`| Target${index} | b |\n`.repeat(100)}`
      ).join('\n\n')
    )
    const matches = await engine.search('Target19')
    expect(matches?.matches.length).toBe(100)
    const indices = Array.from({ length: 20 }, (_, index) => index)
    expect(engine.blocks(indices).find((block) => block.index === 19)?.oversized).toBe(true)
    const prioritized = markdownPreviewRequestIndices(indices, [19, 0])
    expect(prioritized[0]).toBe(19)
    expect(engine.blocks(prioritized).find((block) => block.index === 19)?.oversized).toBe(false)
  })

  it('preserves descendant source ranges for generated footnote sections', () => {
    const engine = new MarkdownPreviewDocumentEngine()
    const document = engine.load('# Start\n\nNote[^n].\n\n[^n]: Footnote note\n')
    const footnotes = document.blocks.at(-1)
    expect(footnotes?.sourceLine).toBe(5)
    expect(footnotes?.sourceEndLine).toBe(5)
  })
})
