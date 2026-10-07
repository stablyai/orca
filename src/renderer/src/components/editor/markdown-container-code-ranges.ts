import { Lexer, type Token } from 'marked'
import {
  forEachMarkdownLine,
  getMarkdownFenceRanges,
  type MarkdownFenceRanges
} from './markdown-fence-scanner'

const MAX_CONTAINER_SCAN_CHARS = 50_000
const CONTAINER_FENCE_CANDIDATE =
  /^(?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))+[ \t]*(?:`{3,}|~{3,})/m

export function hasMarkdownContainerFenceCandidate(content: string): boolean {
  return CONTAINER_FENCE_CANDIDATE.test(content)
}

function countLineBreaks(content: string): number {
  return content.match(/\n/g)?.length ?? 0
}

export function getRichMarkdownFenceRanges(content: string): MarkdownFenceRanges | null {
  if (!hasMarkdownContainerFenceCandidate(content)) {
    return getMarkdownFenceRanges(content, [], true)
  }
  if (content.length > MAX_CONTAINER_SCAN_CHARS) {
    return null
  }

  const lineStarts: number[] = []
  const lineEnds: number[] = []
  forEachMarkdownLine(content, (start, _end, next) => {
    lineStarts.push(start)
    lineEnds.push(next)
  })
  const ranges: [number, number][] = []
  let valid = true

  const visit = (tokens: Token[], source: string, row: number, insideContainer: boolean): void => {
    let cursor = 0
    for (const token of tokens) {
      const start = source.indexOf(token.raw, cursor)
      if (start === -1) {
        valid = false
        return
      }
      row += countLineBreaks(source.slice(cursor, start))
      if (insideContainer && token.type === 'code' && token.codeBlockStyle !== 'indented') {
        const endRow = row + countLineBreaks(token.raw) - (token.raw.endsWith('\n') ? 1 : 0)
        if (lineStarts[row] === undefined || lineEnds[endRow] === undefined) {
          valid = false
        } else {
          ranges.push([lineStarts[row], lineEnds[endRow]])
        }
      } else if (token.type === 'blockquote') {
        // Marked removes prefixes and expands tabs without changing source rows.
        if (!token.tokens || countLineBreaks(token.raw) < countLineBreaks(token.text)) {
          valid = false
        } else {
          visit(token.tokens, token.text, row, true)
        }
      } else if (token.type === 'list') {
        let itemCursor = 0
        let itemRow = row
        for (const item of token.items) {
          const itemStart = token.raw.indexOf(item.raw, itemCursor)
          if (itemStart === -1) {
            valid = false
            break
          }
          itemRow += countLineBreaks(token.raw.slice(itemCursor, itemStart))
          if (item.tokens.length > 0) {
            if (countLineBreaks(item.raw) < countLineBreaks(item.text)) {
              valid = false
            } else {
              visit(item.tokens, item.text, itemRow, true)
            }
          }
          itemRow += countLineBreaks(item.raw)
          itemCursor = itemStart + item.raw.length
        }
      }
      row += countLineBreaks(token.raw)
      cursor = start + token.raw.length
    }
  }

  try {
    const source = content.replace(/\r\n|\r/g, '\n')
    visit(new Lexer({ gfm: true }).blockTokens(source), source, 0, false)
  } catch {
    return null
  }
  if (!valid) {
    return null
  }
  return [...ranges, ...getMarkdownFenceRanges(content, ranges, true)].sort((a, b) => a[0] - b[0])
}
