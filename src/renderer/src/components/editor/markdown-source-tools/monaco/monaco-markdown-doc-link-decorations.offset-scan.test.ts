import type { IRange } from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import { getMarkdownDocLinkTarget } from '../../markdown/documents/markdown-doc-links'
import { createMarkdownFenceTracker } from '../../markdown/source-scanning/markdown-fence-scanner'
import { getMarkdownDocLinkDecorationRanges } from './monaco-markdown-doc-link-decorations'

// Keep the pre-offset scan as an independent oracle; fence detection remains the shared scanner’s contract.
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
  const fence = createMarkdownFenceTracker()
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

    if (fence.consume(line) || fence.insideFence) {
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

describe('getMarkdownDocLinkDecorationRanges offset scan', () => {
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

    // Exhausted delimiter cursors must stay exhausted so link-free inputs do not rescan each line’s tail.
    expect(indexOfCalls).toBeLessThanOrEqual(8)
  })

  it('visits inline-code span offsets linearly across a generated link index', () => {
    const pairs = 500
    const content = '`[[hidden]]` [[shown]] '.repeat(pairs)
    const realPush = Array.prototype.push
    let spanReads = 0
    Array.prototype.push = function <T>(this: T[], ...values: T[]): number {
      const length = realPush.call(this, ...values)
      // Why: the production scanner stores spans as flat numeric pairs; count their reads without changing values.
      if (values.length === 2 && values.every((value) => typeof value === 'number')) {
        for (let index = 0; index < values.length; index += 1) {
          const value = values[index]
          Object.defineProperty(this, length - values.length + index, {
            configurable: true,
            enumerable: true,
            get: () => {
              spanReads += 1
              return value
            }
          })
        }
      }
      return length
    }
    let ranges: IRange[]
    try {
      ranges = getMarkdownDocLinkDecorationRanges(content)
    } finally {
      Array.prototype.push = realPush
    }
    expect(ranges).toEqual(referenceDecorationRanges(content))
    expect(ranges).toHaveLength(pairs)
    expect(spanReads).toBeLessThanOrEqual(pairs * 8)
  })
})
