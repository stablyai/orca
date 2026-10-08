import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { parseMarkdownPreviewDocument } from './markdown-preview-document-tree'

const parser = unified().use(remarkParse).use(remarkGfm)

describe('Markdown table parsing', () => {
  it('preserves alignment, escaped pipes, inline syntax, and source positions', () => {
    const source =
      '| left | right |\n| :- | -: |\n| escaped \\| pipe | `code` |\n| ~~deleted~~ | [link][r] |\n\n[r]: https://example.com\n'
    const table = parser.parse(source).children[0]
    expect(table.type).toBe('table')
    if (table.type !== 'table') {
      throw new Error('Expected a table')
    }
    expect(table.align).toEqual(['left', 'right'])
    expect(table.position).toMatchObject({
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 4, column: 28 }
    })
    expect(table.children[1].children.map((cell) => cell.children)).toMatchObject([
      [{ type: 'text', value: 'escaped | pipe' }],
      [{ type: 'inlineCode', value: 'code' }]
    ])
    expect(table.children[2].children.map((cell) => cell.children)).toMatchObject([
      [{ type: 'delete', children: [{ type: 'text', value: 'deleted' }] }],
      [{ type: 'linkReference', identifier: 'r' }]
    ])
  })

  it('keeps tables inside block quotes and list items', () => {
    const quote = parser.parse('> | a | b |\n> | --- | --- |\n> | x | y |\n').children[0]
    expect(quote).toMatchObject({ type: 'blockquote', children: [{ type: 'table' }] })
    const list = parser.parse('- item\n\n  | a | b |\n  | --- | --- |\n  | x | y |\n').children[0]
    expect(list).toMatchObject({
      type: 'list',
      children: [{ type: 'listItem', children: [{ type: 'paragraph' }, { type: 'table' }] }]
    })
  })

  it('parses thousands of tables with global references and original line ranges', () => {
    const section = '## Table\n\n[Reference][later]\n\n| a | b |\n| --- | --- |\n| x | y |\n\n'
    const { tree, document } = parseMarkdownPreviewDocument(
      `${section.repeat(2000)}[later]: https://example.com\n`
    )
    expect(document.blocks).toHaveLength(6000)
    expect(document.toc).toHaveLength(2000)
    expect(document.blocks.at(-1)).toMatchObject({
      sourceLine: 1999 * 8 + 5,
      sourceEndLine: 1999 * 8 + 7
    })
    expect(tree.children.at(-1)).toMatchObject({ type: 'element', tagName: 'table' })
    expect(tree.children[5998]).toMatchObject({
      type: 'element',
      tagName: 'p',
      children: [{ type: 'element', tagName: 'a', properties: { href: 'https://example.com' } }]
    })
  })
})
