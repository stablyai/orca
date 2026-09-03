import type { IRange } from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'
import { getMarkdownDocLinkDecorationRanges } from './monaco-markdown-doc-link-decorations'

// Why: the pre-offset implementation, kept verbatim as the equivalence oracle
// for the allocation-free scan that replaced it.
function referenceDecorationRanges(content: string): IRange[] {
  const getInlineCodeSpans = (line: string): { start: number; end: number }[] => {
    const spans: { start: number; end: number }[] = []
    let start = -1
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '`' || (index > 0 && line[index - 1] === '\\')) {
        continue
      }
      if (start === -1) {
        start = index
      } else {
        spans.push({ start, end: index + 1 })
        start = -1
      }
    }
    return spans
  }
  const isInsideSpan = (index: number, spans: { start: number; end: number }[]): boolean =>
    spans.some((span) => index >= span.start && index < span.end)

  const ranges: IRange[] = []
  let insideFence = false
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    lineStart = index + 1
    const currentLineNumber = lineNumber
    lineNumber += 1

    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) {
      continue
    }
    const inlineCodeSpans = getInlineCodeSpans(line)
    let searchFrom = 0
    while (searchFrom < line.length) {
      const start = line.indexOf('[[', searchFrom)
      if (start === -1) {
        break
      }
      const end = line.indexOf(']]', start + 2)
      if (end === -1) {
        break
      }
      if (!isInsideSpan(start, inlineCodeSpans)) {
        const target = getMarkdownDocLinkTarget(line.slice(start + 2, end))
        if (target) {
          ranges.push({
            startLineNumber: currentLineNumber,
            startColumn: start + 1,
            endLineNumber: currentLineNumber,
            endColumn: end + 3
          })
        }
      }
      searchFrom = end + 2
    }
  }
  return ranges
}

const CORPUS: { name: string; content: string }[] = [
  { name: 'empty', content: '' },
  { name: 'no links', content: '# Title\n\nJust prose.\n' },
  { name: 'single link', content: '# Title\n\nSee [[notes.md]] for details.\n' },
  { name: 'two links on one line', content: 'See [[a.md]] and [[b.md]].\n' },
  { name: 'link with an anchor', content: 'See [[a.md#heading]].\n' },
  { name: 'link with a display alias', content: 'See [[a.md|Alias]].\n' },
  { name: 'link inside inline code', content: 'Type `[[a.md]]` to link.\n' },
  { name: 'link after inline code', content: 'Type `code` then [[a.md]].\n' },
  { name: 'escaped backtick before a link', content: 'A \\` then [[a.md]] here.\n' },
  {
    name: 'link inside a backtick fence',
    content: '```\n[[a.md]]\n```\n\n[[b.md]]\n'
  },
  {
    name: 'link inside a tilde fence',
    content: '~~~\n[[a.md]]\n~~~\n\n[[b.md]]\n'
  },
  { name: 'indented fence', content: '   ```\n[[a.md]]\n   ```\n[[b.md]]\n' },
  { name: 'unterminated fence', content: '```\n[[a.md]]\n' },
  { name: 'blank line before a fence', content: '\n```\n[[a.md]]\n```\n[[b.md]]\n' },
  { name: 'whitespace-only line then a fence', content: '   \n```js\n[[a.md]]\n```\n[[b.md]]\n' },
  { name: 'open bracket without a close', content: 'See [[a.md and nothing else.\n' },
  { name: 'close on the next line', content: 'See [[a.md\n]] later.\n' },
  { name: 'many unterminated opens', content: '[[a\n[[b\n[[c\n[[d\n' },
  { name: 'empty link body', content: 'See [[]] here.\n' },
  { name: 'no trailing newline', content: 'See [[a.md]]' },
  { name: 'CRLF single link', content: 'See [[a.md]] here.\r\n' },
  { name: 'CRLF link at end of line', content: 'See [[a.md]]\r\nNext [[b.md]]\r\n' },
  { name: 'CRLF fence', content: '```\r\n[[a.md]]\r\n```\r\n[[b.md]]\r\n' },
  { name: 'link split across a CRLF boundary', content: 'See [[a.md\r\n]] here.\r\n' },
  { name: 'consecutive newlines', content: '\n\n[[a.md]]\n\n\n[[b.md]]\n\n' },
  { name: 'nested brackets', content: 'See [[[a.md]]] here.\n' },
  { name: 'unmatched inline code fence', content: 'A ` then [[a.md]] here.\n' }
]

const BIG_DOCUMENT = Array.from({ length: 4_000 }, (_, index) =>
  index % 5 === 0
    ? `Line ${index} links [[doc-${index}.md]] and \`[[skipped-${index}.md]]\`.`
    : `Line ${index} is ordinary prose with no link at all.`
).join('\n')

describe('getMarkdownDocLinkDecorationRanges offset scan', () => {
  it.each(CORPUS)('matches the substring implementation for $name', ({ content }) => {
    expect(getMarkdownDocLinkDecorationRanges(content)).toEqual(referenceDecorationRanges(content))
  })

  it('matches the substring implementation on a large document', () => {
    expect(getMarkdownDocLinkDecorationRanges(BIG_DOCUMENT)).toEqual(
      referenceDecorationRanges(BIG_DOCUMENT)
    )
    expect(getMarkdownDocLinkDecorationRanges(BIG_DOCUMENT).length).toBeGreaterThan(0)
  })

  it('matches the substring implementation on a document with no links at all', () => {
    const noLinks = Array.from({ length: 4_000 }, (_, index) => `Line ${index} prose.`).join('\n')
    expect(getMarkdownDocLinkDecorationRanges(noLinks)).toEqual(referenceDecorationRanges(noLinks))
  })

  it('does not rescan the document tail once per line', () => {
    const linkFree = Array.from(
      { length: 20_000 },
      (_, index) => `Line ${index} prose with no wiki link.`
    ).join('\n')

    const realIndexOf = String.prototype.indexOf
    let indexOfCalls = 0
    String.prototype.indexOf = function (this: string, ...args: unknown[]) {
      indexOfCalls += 1
      return (realIndexOf as (...a: unknown[]) => number).apply(this, args)
    } as typeof String.prototype.indexOf
    try {
      getMarkdownDocLinkDecorationRanges(linkFree)
    } finally {
      String.prototype.indexOf = realIndexOf
    }

    // Why: the delimiter cursors are seeded once and never re-armed while they
    // hold -1, so a link-free document costs a fixed number of searches rather
    // than one tail scan per line.
    expect(indexOfCalls).toBeLessThanOrEqual(8)
  })
})
