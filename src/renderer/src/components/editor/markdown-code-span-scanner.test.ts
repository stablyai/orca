import { describe, expect, it } from 'vitest'
import { createMarkdownCodeSpanScanner } from './markdown-code-span-scanner'
import { stripMarkdownCode } from './markdown-code-stripping'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

const prefix = 'An ordinary paragraph.\n\n'.repeat(2500)

function findSpanEnd(content: string, index: number): number | null {
  return createMarkdownCodeSpanScanner(content).findSpanEnd(index)
}

describe('inline code span delimiters', () => {
  it.each([
    ['equal runs close', 'a `code` b', 8],
    ['longer run is content', 'a ``co`de`` b', 11],
    ['span crosses a line break', 'a `one\ntwo` b', 11],
    ['unequal runs do not close', 'a `code`` b', null],
    ['an unterminated run does not close', 'a `code b', null],
    ['a blank line ends the block', 'a `one\n\ntwo` b', null],
    ['a fence delimiter ends the block', 'a `one\n```\nx\n```\ntwo` b', null]
  ])('%s', (_name, content, end) => {
    expect(findSpanEnd(content, content.indexOf('`'))).toBe(end)
  })

  it.each([
    ['a heading ends the block', '# a `one\n# b two` c', null],
    ['a heading ends a paragraph too', '# a `one\ntwo` b', null],
    ['a list marker ends the block', '- a `one\n- b two` c', null],
    ['a setext underline ends the block', 'a `one\n===\ntwo` b', null],
    ['a thematic break ends the block', 'a `one\n---\ntwo` b', null],
    ['an HTML block ends the block', 'a `one\n<div>x</div>\ntwo` b', null],
    ['a comment block ends the block', 'a `one\n<!-- x -->\ntwo` b', null],
    ['an indented continuation stays in the block', '- a `one\n  two` b', 15],
    ['blockquote lines stay in one block', '> a `one\n> b two` c', 17],
    ['a lazy continuation stays in the block', '> a `one\ntwo` b', 13],
    ['inline HTML stays in the block', 'a `one\n<br>\ntwo` b', 16]
  ])('%s', (_name, content, end) => {
    expect(findSpanEnd(content, content.indexOf('`'))).toBe(end)
  })

  it.each([
    ['an escaped backtick cannot open', 'a \\`code\\` b', null],
    ['an escaped backtick can close', 'a `code\\` b', 9],
    ['an even backslash run does not escape', 'a \\\\`code` b', 10],
    // The escaped backtick is text and the rest of the run still opens, as in marked.
    ['the tail of an escaped run opens', 'a \\``code` b', 10],
    ['the tail still needs an equal closer', 'a \\``code`` b', null]
  ])('%s', (_name, content, end) => {
    expect(findSpanEnd(content, content.indexOf('`'))).toBe(end)
  })

  it.each([
    ['a table ends the block', 'a `one\n| h |\n| - |\n| two ` b', null],
    ['an opener line can be the header', 'A `one\n| - |\ntwo` B', null],
    ['an aligned delimiter row counts', 'a `one\n| h | i |\n|:--|--:|\n| x | y ` b', null],
    ['a table in a quote ends the block', '> a `one\n> | h |\n> | - |\n> | two ` b', null],
    ['rows do not pair with each other', 'a\n\n| h |\n| - |\n| `one |\n| two ` |', null],
    ['pipes without a delimiter row stay in the block', 'a `x\n| p | q |\nb y` c', 19]
  ])('%s', (_name, content, end) => {
    expect(findSpanEnd(content, content.indexOf('`'))).toBe(end)
  })

  it.each([
    ['a declaration', 'a `one\n| h |\n| - |\n| x <!DOCTYPE html> ` b', '<!DOCTYPE html>'],
    ['a tag', 'a `one\n| h |\n| - |\n| x <div>live</div> ` b', '<div>live</div>'],
    ['a comment', 'a `one\n| h |\n| - |\n| x <!-- note --> ` b', '<!-- note -->'],
    ['a tag under a header opener', 'A `one\n| - |\n<div>live</div> two` B', '<div>live</div>']
  ])('keeps %s in a table cell visible', (_name, content, html) => {
    expect(stripMarkdownCode(content)).toContain(html)
  })

  it('blocks a document whose table cell HTML would not survive', () => {
    const content = 'a `one\n| h |\n| - |\n| x <!DOCTYPE html> ` b'
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('html-or-jsx')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })

  it.each([
    ['an HTML block', 'a `x\n<div>live</div>\ny` b', '<div>live</div>'],
    ['a comment block', 'a `x\n<!-- note -->\ny` b', '<!-- note -->'],
    ['HTML in a quote', 'a `x\n> quoted <div>live</div>\ny` b', '<div>live</div>'],
    ['HTML in a list item', 'a `x\n- item <div>live</div>\ny` b', '<div>live</div>'],
    ['a closing tag', 'a `x\n</div>\ny` b', '</div>']
  ])('leaves %s outside the span', (_name, content, html) => {
    // A span that swallowed one of these would hide live HTML from the guard.
    expect(stripMarkdownCode(content)).toContain(html)
  })

  it('keeps HTML visible when a heading ends the leaf block', () => {
    // marked parses the two headings separately, so these runs are not a span.
    const content = '# a `one\n# b <Widget /> two` c'
    expect(stripMarkdownCode(content)).toBe(content)
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })

  it('keeps HTML visible between escaped backticks', () => {
    const content = 'Text \\`<Widget />\\` tail'
    expect(stripMarkdownCode(content)).toBe(content)
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })

  it('keeps HTML visible when the runs are unequal', () => {
    // CommonMark needs equal-length runs, so this is not code and the tag is live.
    const content = 'Text `<Widget />`` tail'
    expect(stripMarkdownCode(content)).toBe(content)
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })

  it('strips a code span that crosses a line break', () => {
    const content = 'Run `foo --flag=<new>\n  --other=<old>` then stop.'
    expect(stripMarkdownCode(content)).toBe('Run \n then stop.')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBeNull()
  })

  it('leaves a fenced block to the fence scanner', () => {
    expect(stripMarkdownCode('a `x` b\n```\n`y`\n```\nc `z` d')).toBe('a  b\n\n\n\nc  d')
  })

  it('keeps HTML in a later block visible to the guard', () => {
    const content = 'Cost ` each.\n\n<div class="x">live</div>\n\nTotal ` sum.'
    expect(stripMarkdownCode(content)).toContain('<div class="x">live</div>')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })

  it('keeps a reference definition in a later block visible to the guard', () => {
    const content = 'Price is 5 ` per unit.\n\n[ref]: https://example.com\n\nAnd 3 ` more.'
    expect(stripMarkdownCode(content)).toContain('[ref]: https://example.com')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('reference-links')
  })

  it('scans a document full of unmatched runs without rescanning it per run', () => {
    // Descending run lengths never find a closer, which used to be quadratic.
    let content = ''
    for (let length = 900; length >= 1; length -= 1) {
      content += `${'word '.repeat(8)}${'`'.repeat(length)}`
    }
    const startedAt = Date.now()
    stripMarkdownCode(content)
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })
})
