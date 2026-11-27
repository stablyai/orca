import { describe, expect, it } from 'vitest'
import { createMarkdownCodeSpanScanner } from './markdown-code-span-scanner'

function spanEndAfter(content: string, marker: string): number | null {
  return createMarkdownCodeSpanScanner(content).findSpanEnd(
    content.indexOf('`', content.indexOf(marker))
  )
}

describe('GFM table code span boundaries', () => {
  it('keeps code spans inside one cell', () => {
    const table = '| first ` | second ` |\n| --- | --- |\n| third ` | fourth ` |\n'
    expect(spanEndAfter(table, 'first')).toBeNull()
    expect(spanEndAfter(table, 'third')).toBeNull()
  })

  it('splits cells at unescaped pipes only', () => {
    expect(spanEndAfter('| `a | b` |\n| --- | --- |\n', '')).toBeNull()
    const escaped = '| `a\\|b` | c |\n| --- | --- |\n'
    expect(spanEndAfter(escaped, '')).toBe(escaped.indexOf(' | c'))
  })

  it('leaves a paragraph whole when header and delimiter cell counts differ', () => {
    const paragraph = 'x ` | y ` | z\n|---|---|\n'
    expect(spanEndAfter(paragraph, '')).toBe(paragraph.indexOf(' | z'))
  })

  it('ends the table at a quoted blank line', () => {
    const quoted = '> | a | b |\n> |---|---|\n>\n> c ` | d `\n'
    expect(spanEndAfter(quoted, 'c')).toBe(quoted.length - 1)
  })

  it('keeps rows that start with later ordinals or setext marks', () => {
    const rows = '| h | i |\n| --- | --- |\n2. a ` | b ` |\n--\n| c ` | d ` |\n'
    expect(spanEndAfter(rows, '2.')).toBeNull()
    expect(spanEndAfter(rows, 'c')).toBeNull()
  })

  it('ends a table inside a list item at the next list marker', () => {
    const listed = '1. x\n   | h | i |\n   |---|---|\n2. `a | b`\n'
    expect(spanEndAfter(listed, '2.')).toBe(listed.length - 1)
  })

  it('does not treat a list item shaped like a delimiter as a table', () => {
    const lazy = '- item\n| `a|b` |\n- |---|\n'
    expect(spanEndAfter(lazy, '|')).toBe(lazy.indexOf(' |\n-'))
  })

  it('does not split a lazy line whose indent differs from the delimiter row', () => {
    const lazy = '1. a\n  - b\n  | `p` | `q` |\n---|---\n`r | s` | t\n'
    expect(spanEndAfter(lazy, '`r')).toBe(lazy.indexOf(' | t'))
  })

  it('does not treat a setext underline as a table header', () => {
    const setext = '| h | i |\n===\n|---|\n| `a | b` | c |\n'
    expect(spanEndAfter(setext, '| `a')).toBe(setext.indexOf(' | c'))
  })
})
