import { marked } from 'marked'

import { describe, expect, it } from 'vitest'
import { markdownCodeSpanRanges, markdownFenceRanges } from './markdown-scan-ranges'
import { createMarkdownCodeSpanScanner } from './markdown-code-span-scanner'

describe('standalone Markdown boundaries', () => {
  it('rejects backticks in a backtick fence info string', () => {
    expect(markdownFenceRanges('```bad`info\ntext')).toEqual([])
    expect(markdownFenceRanges('~~~bad`info\ntext\n~~~')).toEqual([[0, 20]])
  })

  it('does not open a code span on an escaped backtick', () => {
    expect(markdownCodeSpanRanges('\\`literal\\`')).toEqual([])
    const scanner = createMarkdownCodeSpanScanner('\\`literal\\`')
    expect(scanner.findSpanEnd(1)).toBeNull()
  })

  it('accepts CR-only fence lines', () => {
    const source = '```\rcode\r```\rafter'
    expect(markdownFenceRanges(source)).toEqual([[0, 13]])
  })
})

it('does not expose inline spans inside fenced content', () => {
  const source = '```\n`x`\n```'
  expect(createMarkdownCodeSpanScanner(source).findSpanEnd(4)).toBeNull()
})

it.each(['-', '--', '---'])('keeps multiline spans after a bare %s line', (divider) => {
  const source = `Text\n${divider}\nA \`code\nspan\` here`
  const spans: string[] = []
  marked.walkTokens(marked.lexer(source), (token) => {
    if (token.type === 'codespan') {
      spans.push(token.raw)
    }
  })
  expect(spans).toEqual(['`code\nspan`'])
  expect(createMarkdownCodeSpanScanner(source).findSpanEnd(source.indexOf('`'))).toBe(
    source.lastIndexOf('`') + 1
  )
})

it.each(['| --- |', ':---'])('keeps table rows separate for %s', (delimiter) => {
  const source = `| header |\n${delimiter}\n| \`code |\n| span\` |`
  expect(marked.lexer(source)[0].type).toBe('table')
  expect(createMarkdownCodeSpanScanner(source).findSpanEnd(source.indexOf('`'))).toBeNull()
})
