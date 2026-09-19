import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { renderTableToCompactMarkdown } from './rich-markdown-table-markdown'

const helpers: MarkdownRendererHelpers = {
  renderChildren: (nodes) => {
    const visit = (node: JSONContent): string =>
      node.type === 'text' ? (node.text ?? '') : (node.content ?? []).map(visit).join('')
    return (Array.isArray(nodes) ? nodes : [nodes]).map(visit).join('')
  },
  wrapInBlock: (_prefix, content) => content,
  indent: (content) => content
}

function table(header: string[], body: string[][]): JSONContent {
  const cell = (text: string, type: 'tableCell' | 'tableHeader'): JSONContent => ({
    type,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: header.map((text) => cell(text, 'tableHeader')) },
      ...body.map((row) => ({
        type: 'tableRow',
        content: row.map((text) => cell(text, 'tableCell'))
      }))
    ]
  }
}

const lines = (markdown: string) => markdown.split('\n').filter((line) => line.startsWith('|'))

describe('compact Markdown table serialization', () => {
  it('keeps short tables fully aligned', () => {
    const output = renderTableToCompactMarkdown(
      table(
        ['Term', 'Definition'],
        [
          ['one', 'a value'],
          ['two', 'another value']
        ]
      ),
      helpers
    )
    expect(new Set(lines(output).map((line) => line.length)).size).toBe(1)
  })

  it('does not let one long cell inflate every row', () => {
    const long = 'x'.repeat(200)
    const output = renderTableToCompactMarkdown(
      table(
        ['id', 'notes', 'kind'],
        [
          ['1', '-', 'a'],
          ['2', long, 'b'],
          ['3', '-', 'c']
        ]
      ),
      helpers
    )
    const separator = lines(output)[1] ?? ''
    expect(separator.split('|')[2]?.trim().length).toBeLessThan(10)
    expect(
      Math.max(
        ...lines(output)
          .filter((line) => !line.includes(long))
          .map((line) => line.length)
      )
    ).toBeLessThan(25)
  })

  it('caps uniformly huge columns while preserving the long cell', () => {
    const huge = 'x'.repeat(300)
    const output = renderTableToCompactMarkdown(
      table(
        ['a', 'b'],
        [
          [huge, 'short'],
          [huge, 'short']
        ]
      ),
      helpers
    )
    expect(lines(output)[1]?.length ?? 0).toBeLessThan(140)
    expect(output).toContain(huge)
  })

  it('counts alignment markers inside the separator width', () => {
    const node = table(['left', 'center', 'right'], [['a', 'b', '42']])
    for (const [index, align] of ['left', 'center', 'right'].entries()) {
      const header = node.content?.[0]?.content?.[index]
      if (header) {
        header.attrs = { align }
      }
    }
    const header = lines(renderTableToCompactMarkdown(node, helpers))[0]
    const rows = lines(renderTableToCompactMarkdown(node, helpers))
    expect(rows[1]?.length).toBe(header?.length)
    expect(rows[1]).toContain(':---')
    expect(rows[1]).toContain(':----:')
    expect(rows[1]).toContain('---:')
  })

  it('keeps multiple blocks in a cell on one Markdown table row', () => {
    const node: JSONContent = {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }]
            }
          ]
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }
              ]
            }
          ]
        }
      ]
    }

    const output = renderTableToCompactMarkdown(node, helpers)
    expect(output).toContain('first<br>second')
    expect(lines(output).every((line) => !line.includes('\n'))).toBe(true)
  })
})
