import { marked } from 'marked'
import { stripMarkdownCode } from './markdown-code-stripping'
import { getMarkdownFenceRanges } from './markdown-fence-scanner'
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

it.each(['\n', '\r\n', '\r'])('retains %j terminators while stripping code', (eol) => {
  expect(stripMarkdownCode(['before', '`code`', 'after'].join(eol))).toBe(
    ['before', '', 'after'].join(eol)
  )
})

it.each(['```~~~', '``` ~', '```\t', '      ```'])(
  'matches the parser on the closer %j',
  (closer) => {
    const source = `\`\`\`\ncode\n${closer}\n<div>after</div>\n`
    const code = marked.lexer(source)[0]
    expect(code.type).toBe('code')
    expect(getMarkdownFenceRanges(source)).toEqual([[0, code.raw.length]])
    expect(stripMarkdownCode(source).includes('<div>after</div>')).toBe(closer === '```~~~')
  }
)

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
