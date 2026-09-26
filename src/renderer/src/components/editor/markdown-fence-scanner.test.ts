import { describe, expect, it } from 'vitest'
import { marked } from 'marked'
import { stripMarkdownCode } from './markdown-code-stripping'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import {
  createMarkdownFenceRangeCursor,
  createMarkdownFenceTracker,
  findMarkdownLineEnd,
  forEachMarkdownLine,
  getMarkdownFenceRanges,
  isInsideMarkdownFenceRange,
  skipMarkdownLineBreak
} from './markdown-fence-scanner'

// Feeds every line of `content` and reports, per line, whether the tracker
// treated it as a delimiter and whether it was inside a block beforehand.
function scan(content: string): { line: string; isFenceLine: boolean; wasInside: boolean }[] {
  const fence = createMarkdownFenceTracker()
  return content.split('\n').map((line) => {
    const wasInside = fence.insideFence
    return { line, isFenceLine: fence.consume(line), wasInside }
  })
}

const insideFenceLines = (content: string): string[] =>
  scan(content)
    .filter(({ isFenceLine, wasInside }) => wasInside && !isFenceLine)
    .map(({ line }) => line)

describe('createMarkdownFenceTracker', () => {
  it.each([
    ['exact-length closer', '```\nbody\n```'],
    ['longer closer', '```\nbody\n`````'],
    ['closer with trailing whitespace', '```\nbody\n```  \t'],
    ['tilde closer', '~~~\nbody\n~~~']
  ])('closes on a %s', (_name, content) => {
    expect(insideFenceLines(content)).toEqual(['body'])
    expect(scan(content).at(-1)).toMatchObject({ isFenceLine: true, wasInside: true })
  })

  it.each([
    ['shorter run', '````\nbody\n```\nstill code\n````'],
    ['other marker', '````\nbody\n~~~\nstill code\n````'],
    ['info string', '````\nbody\n````js\nstill code\n````'],
    ['trailing text', '````\nbody\n```` trailing\nstill code\n````']
  ])('keeps the block open across a %s', (_name, content) => {
    expect(insideFenceLines(content)).toEqual(['body', 'still code'])
  })

  it('reports a fence-shaped line inside a block as a delimiter, not as text', () => {
    expect(scan('````\n```js\n````')[1]).toEqual({
      line: '```js',
      isFenceLine: true,
      wasInside: true
    })
  })

  it('leaves a backtick opener whose info string holds a backtick as ordinary text', () => {
    expect(scan('```a`b\n<div>x</div>')).toEqual([
      { line: '```a`b', isFenceLine: false, wasInside: false },
      { line: '<div>x</div>', isFenceLine: false, wasInside: false }
    ])
  })

  it('accepts a backtick in a tilde opener info string', () => {
    expect(insideFenceLines('~~~a`b\nbody\n~~~')).toEqual(['body'])
  })

  it('stays open at the end of a document with no closer', () => {
    const fence = createMarkdownFenceTracker()
    for (const line of ['```', 'body']) {
      fence.consume(line)
    }
    expect(fence.insideFence).toBe(true)
  })

  it.each([
    ['form feed', '\f'],
    ['vertical tab', '\v'],
    ['non-breaking space', ' '],
    ['line separator', ' ']
  ])('does not accept %s as fence indentation', (_name, indent) => {
    expect(scan(`${indent}\`\`\`\nbody`)).toEqual([
      { line: `${indent}\`\`\``, isFenceLine: false, wasInside: false },
      { line: 'body', isFenceLine: false, wasInside: false }
    ])
  })
})

describe('markdown line splitting', () => {
  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['lone CR', 'a\rb']
  ])('treats %s as a line break, as marked does', (_name, content) => {
    const lines: string[] = []
    forEachMarkdownLine(content, (start, end) => lines.push(content.slice(start, end)))
    expect(lines).toEqual(['a', 'b'])
  })

  it('reports the terminator offsets without allocating substrings', () => {
    const content = 'a\r\nb\rc\n'
    expect(findMarkdownLineEnd(content, 0)).toBe(1)
    expect(skipMarkdownLineBreak(content, 1)).toBe(3)
    expect(skipMarkdownLineBreak(content, 4)).toBe(5)
    expect(findMarkdownLineEnd(content, 7)).toBe(7)
    expect(skipMarkdownLineBreak(content, 7)).toBe(7)
  })

  it('closes a fence that a lone CR puts on its own line', () => {
    const content = '```\ncode\n\r```\n<div>hi</div>\n'
    const ranges = getMarkdownFenceRanges(content)
    expect(ranges).toHaveLength(1)
    expect(content.slice(...ranges[0])).toBe('```\ncode\n\r```\n')
  })
})

describe('getMarkdownFenceRanges', () => {
  it('spans the delimiter lines and runs to the end when a fence never closes', () => {
    const content = 'intro\n```\none\n```\ntail\n~~~\nopen'
    expect(getMarkdownFenceRanges(content).map((range) => content.slice(...range))).toEqual([
      '```\none\n```\n',
      '~~~\nopen'
    ])
  })

  it.each([
    ['', 0],
    ['no fences here\n', 0],
    ['```\n', 1]
  ])('handles %j', (content, expected) => {
    expect(getMarkdownFenceRanges(content)).toHaveLength(expected)
  })

  it('answers membership the same way through the cursor and the scan', () => {
    const content = 'a\n```\nb\n```\nc'
    const ranges = getMarkdownFenceRanges(content)
    const cursor = createMarkdownFenceRangeCursor(ranges)
    for (let index = 0; index < content.length; index += 1) {
      expect(cursor(index)).toBe(isInsideMarkdownFenceRange(index, ranges))
    }
  })
})

// marked is what parses the document downstream, so the tracker has to agree with it
// about where a fence closes; disagreeing either hides HTML from the guard or blocks
// a document that is fine.
describe('fence boundaries against marked', () => {
  const openers = ['```', '````', '~~~', '```js']
  const closers = [
    '```',
    '````',
    '~~~',
    '```~~~',
    '~~~```',
    '```` ',
    '```js',
    '``` trailing',
    '```~~~   '
  ]

  it.each(openers)('agrees with marked for every closer after %j', (opener) => {
    for (const closer of closers) {
      const content = `${opener}\ncode\n${closer}\nAFTER <div>x</div>\n`
      expect({ closer, ranges: getMarkdownFenceRanges(content) }).toEqual({
        closer,
        ranges: markedFenceRanges(content)
      })
    }
  })

  it('keeps HTML after a mixed-marker closer visible to the guard', () => {
    const prefix = 'An ordinary paragraph.\n\n'.repeat(2500)
    const content = '```\ncode\n```~~~\n<div>outside</div>\n'
    expect(stripMarkdownCode(content)).toContain('<div>outside</div>')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}${content}`)).toBe('html-or-jsx')
  })
})

/** Where marked itself puts each fenced block, as offsets. */
function markedFenceRanges(content: string): [number, number][] {
  const ranges: [number, number][] = []
  let offset = 0
  for (const token of marked.lexer(content)) {
    if (token.type === 'code' && /^[ \t]*(`{3,}|~{3,})/.test(token.raw)) {
      ranges.push([offset, offset + token.raw.length])
    }
    offset += token.raw.length
  }
  return ranges
}
