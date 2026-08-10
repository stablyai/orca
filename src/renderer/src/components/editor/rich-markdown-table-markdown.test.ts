import { describe, it, expect } from 'vitest'
import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { renderTableToCompactMarkdown } from './rich-markdown-table-markdown'

// Mock helper: renderChildren returns the concatenated text of the cell's nodes,
// which is all the table serializer reads from each cell.
const helpers = {
  renderChildren: (nodes: JSONContent | JSONContent[]): string => {
    const list = Array.isArray(nodes) ? nodes : [nodes]
    const text = (node: JSONContent): string =>
      node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(text).join('')
    return list.map(text).join('')
  }
} as unknown as MarkdownRendererHelpers

function cell(text: string, type: 'tableCell' | 'tableHeader'): JSONContent {
  return { type, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function table(header: string[], body: string[][]): JSONContent {
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: header.map((t) => cell(t, 'tableHeader')) },
      ...body.map((row) => ({ type: 'tableRow', content: row.map((t) => cell(t, 'tableCell')) }))
    ]
  }
}

const widthOf = (md: string): number => Math.max(...md.split('\n').map((line) => line.length))
const lines = (md: string): string[] => md.split('\n').filter((line) => line.startsWith('|'))

describe('renderTableToCompactMarkdown', () => {
  it('aligns two uniformly-wide columns to their content', () => {
    const md = renderTableToCompactMarkdown(
      table(
        ['Term', 'Definition'],
        [
          ['context artifact', 'content injected through a harness mechanism'],
          ['condition / arm', 'the unique combination identifying a setup']
        ]
      ),
      helpers
    )
    // Both body rows pad to the same width → the trailing pipe lines up.
    const barColumns = lines(md).map((line) => line.lastIndexOf('|'))
    expect(new Set(barColumns).size).toBe(1)
  })

  it('clamps a lone long cell once full alignment would exceed the width budget', () => {
    const long = 'x'.repeat(200) // pushes the table well past MAX_ALIGNED_TABLE_WIDTH
    const md = renderTableToCompactMarkdown(
      table(
        ['id', 'notes', 'k'],
        [
          ['1', '-', '1'],
          ['2', long, '3'],
          ['3', '-', '1']
        ]
      ),
      helpers
    )
    // The notes column (index 1) clamps to the short cluster, not the 200-char cell.
    const dashCols = lines(md)[1]
      .split('|')
      .map((seg) => seg.trim())
      .filter((seg) => /^-+$/.test(seg))
    expect(dashCols[1].length).toBeLessThan(10)
    // The non-outlier rows stay narrow; only the outlier row overflows.
    const shortRows = lines(md).filter((line) => !line.includes(long))
    expect(Math.max(...shortRows.map((line) => line.length))).toBeLessThan(25)
  })

  it('absorbs an outlier and aligns fully when the table stays under the budget', () => {
    const notes = 'flaky on retry; see the run-trial preflight logs for the cache-taint note'
    const md = renderTableToCompactMarkdown(
      table(
        ['id', 'name', 'status', 'notes', 'k', 'cost', 'ms', 'pass'],
        [
          ['1', 'opus', 'ok', '-', '1', '0.12', '8400', 'yes'],
          ['2', 'sonnet', 'ok', notes, '3', '0.04', '5200', 'no'],
          ['3', 'codex', 'ok', '-', '1', '0.09', '7700', 'yes']
        ]
      ),
      helpers
    )
    // Every row is padded to the same width, so trailing columns line up even on
    // the outlier row (no solo spill).
    const rowLengths = lines(md).map((line) => line.length)
    expect(new Set(rowLengths).size).toBe(1)
  })

  it('caps uniformly-huge columns so short cells do not pad out to hundreds', () => {
    const huge = 'x'.repeat(300)
    const md = renderTableToCompactMarkdown(
      table(
        ['a', 'b'],
        [
          [huge, 'short'],
          [huge, 'short']
        ]
      ),
      helpers
    )
    // Column b's short cells pad to the ceiling (60), never to 300.
    const separator = lines(md)[1]
    expect(separator.length).toBeLessThan(140)
    expect(widthOf(md)).toBeGreaterThan(300) // the huge cell itself still fits on one line
  })

  it('keeps a short header from overflowing its own column', () => {
    const md = renderTableToCompactMarkdown(
      table(
        ['Status', 'Note'],
        [
          ['ok', 'a'],
          ['ok', 'b']
        ]
      ),
      helpers
    )
    const header = lines(md)[0]
    // Header "Status" is fully present and padded, not truncated/overflowing.
    expect(header).toContain('| Status |')
  })

  it('escapes literal pipes in cell content so the row keeps its columns', () => {
    const md = renderTableToCompactMarkdown(table(['a', 'b'], [['x | y', 'z']]), helpers)
    const body = lines(md).find((line) => line.includes('x'))!
    // Pipe is backslash-escaped, so it is not read as a fourth column delimiter.
    expect(body).toContain('x \\| y')
    expect(body).not.toContain('x | y')
  })

  it('preserves alignment markers without widening the separator row', () => {
    const alignedHeader = (text: string, align: 'left' | 'center' | 'right'): JSONContent => ({
      type: 'tableHeader',
      attrs: align ? { align } : {},
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    })
    const node: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            alignedHeader('longer left cell', 'left'),
            alignedHeader('mid', 'center'),
            alignedHeader('n', 'right')
          ]
        },
        {
          type: 'tableRow',
          content: [cell('a', 'tableCell'), cell('b', 'tableCell'), cell('42', 'tableCell')]
        }
      ]
    }
    const rendered = lines(renderTableToCompactMarkdown(node, helpers))
    const [header, separator, body] = rendered
    expect(separator).toContain(':-') // left/center open with a colon
    expect(separator).toContain('-:') // right/center close with a colon
    // Colons count toward the width, so every row is exactly the same length.
    expect(separator.length).toBe(header.length)
    expect(body.length).toBe(header.length)
  })
})
