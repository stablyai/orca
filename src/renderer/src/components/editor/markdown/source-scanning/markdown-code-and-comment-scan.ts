import { advanceHtmlCommentStateOnLine, findInlineCodeSpanEnd } from './markdown-html-comment-scan'

export function countBlockquoteDepth(prefix: string): number {
  let depth = 0
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix.charCodeAt(i) === 62) {
      depth += 1
    }
  }
  return depth
}

/** Strips exactly `levels` CommonMark blockquote markers (0-3 spaces, `>`, optional space). */
export function stripBlockquoteLevels(line: string, levels: number): string | null {
  let index = 0
  for (let level = 0; level < levels; level += 1) {
    let spaces = 0
    while (index < line.length && spaces < 3 && line.charCodeAt(index) === 32) {
      index += 1
      spaces += 1
    }
    if (index >= line.length || line.charCodeAt(index) !== 62) {
      return null
    }
    index += 1
    if (index < line.length && line.charCodeAt(index) === 32) {
      index += 1
    }
  }
  return line.slice(index)
}

function stripAllBlockquotePrefixes(line: string): {
  depth: number
  content: string
  prefixLength: number
} {
  let depth = 0
  let index = 0
  while (index < line.length) {
    let cursor = index
    let spaces = 0
    while (cursor < line.length && spaces < 3 && line.charCodeAt(cursor) === 32) {
      cursor += 1
      spaces += 1
    }
    if (cursor >= line.length || line.charCodeAt(cursor) !== 62) {
      break
    }
    cursor += 1
    if (cursor < line.length && line.charCodeAt(cursor) === 32) {
      cursor += 1
    }
    depth += 1
    index = cursor
  }
  return { depth, content: line.slice(index), prefixLength: index }
}

function measureLeadingColumns(text: string): { columns: number; offset: number } {
  let columns = 0
  let offset = 0
  while (offset < text.length) {
    const ch = text.charCodeAt(offset)
    if (ch === 32) {
      columns += 1
      offset += 1
    } else if (ch === 9) {
      columns += 4 - (columns % 4)
      offset += 1
    } else {
      break
    }
  }
  return { columns, offset }
}

function detectContainerLine(
  text: string,
  columns: number,
  offset: number,
  baseIndent: number
): { contentIndent: number; remainder: string } | null {
  if (columns > baseIndent + 3) {
    return null
  }
  const rest = text.slice(offset)
  const footnoteMatch = rest.match(/^\[\^[^\s[\]]+\]:(?:([ \t]+)|$)/)
  if (footnoteMatch) {
    return {
      contentIndent: baseIndent + 4,
      remainder: rest.slice(footnoteMatch[0].length)
    }
  }
  const listMatch = rest.match(/^([-+*]|\d{1,9}[.)])([ \t]+|$)/)
  if (!listMatch) {
    return null
  }
  const markerWidth = listMatch[1].length
  const ws = listMatch[2]
  const remainder = rest.slice(listMatch[0].length)
  if (ws.length === 0 || remainder.length === 0) {
    return { contentIndent: columns + markerWidth + 1, remainder }
  }
  let col = columns + markerWidth
  for (let i = 0; i < ws.length; i += 1) {
    col += ws.charCodeAt(i) === 9 ? 4 - (col % 4) : 1
  }
  const wsCols = col - (columns + markerWidth)
  const contentIndent = wsCols >= 5 ? columns + markerWidth + 1 : col
  return { contentIndent, remainder }
}

function matchFenceOpener(text: string): { marker: '`' | '~'; length: number } | null {
  const match = text.match(/^(`{3,}|~{3,})(.*)$/)
  if (!match) {
    return null
  }
  const marker = match[1][0] === '~' ? '~' : '`'
  if (marker === '`' && match[2].includes('`')) {
    return null
  }
  return { marker, length: match[1].length }
}

function isMatchingFenceCloser(
  text: string,
  columns: number,
  offset: number,
  fence: { marker: '`' | '~'; length: number; containerIndent: number }
): boolean {
  if (columns > fence.containerIndent + 3) {
    return false
  }
  const match = text.slice(offset).match(/^(`{3,}|~{3,})[ \t]*$/)
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length)
}

function stripInlineCodeSpans(line: string): string {
  if (!line.includes('`')) {
    return line
  }
  let output = ''
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      output += line[index]
      index += 1
      continue
    }
    const spanEnd = findInlineCodeSpanEnd(line, index)
    if (spanEnd !== -1) {
      index = spanEnd
      continue
    }
    let tickCount = 0
    while (line[index + tickCount] === '`') {
      tickCount += 1
    }
    output += line.slice(index, index + tickCount)
    index += tickCount
  }
  return output
}

/** Removes fenced code blocks (respecting blockquotes, list/footnote indentation, and HTML comments) and inline code spans. */
export function stripMarkdownCode(content: string): string {
  const lastCommentClose = content.lastIndexOf('-->')
  const containers: { quoteDepth: number; indent: number }[] = []
  let activeFence: {
    marker: '`' | '~'
    length: number
    quoteDepth: number
    containerIndent: number
  } | null = null
  let inHtmlComment = false
  let sanitized = ''
  let lineStart = 0

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const index = newlineIndex === -1 ? content.length : newlineIndex
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    const appendNewline = index < content.length ? '\n' : ''

    if (activeFence !== null) {
      const containerLine =
        activeFence.quoteDepth === 0 ? line : stripBlockquoteLevels(line, activeFence.quoteDepth)
      if (containerLine !== null) {
        const { columns, offset } = measureLeadingColumns(containerLine)
        if (isMatchingFenceCloser(containerLine, columns, offset, activeFence)) {
          activeFence = null
        }
        sanitized += appendNewline
        lineStart = index + 1
        continue
      }
      activeFence = null
    }

    if (inHtmlComment) {
      sanitized += line + appendNewline
      inHtmlComment = advanceHtmlCommentStateOnLine(line, lineStart, true, lastCommentClose)
      lineStart = index + 1
      continue
    }

    const {
      depth: quoteDepth,
      content: lineWithoutQuote,
      prefixLength
    } = stripAllBlockquotePrefixes(line)
    while ((containers.at(-1)?.quoteDepth ?? -1) > quoteDepth) {
      containers.pop()
    }

    const { columns, offset } = measureLeadingColumns(lineWithoutQuote)
    const isBlank = offset === lineWithoutQuote.length
    if (!isBlank) {
      while (
        containers.at(-1)?.quoteDepth === quoteDepth &&
        (containers.at(-1)?.indent ?? -1) > columns
      ) {
        containers.pop()
      }
    }

    const top = containers.at(-1)
    const baseIndent = top && top.quoteDepth === quoteDepth ? top.indent : 0

    if (!isBlank && columns <= baseIndent + 3) {
      const opener = matchFenceOpener(lineWithoutQuote.slice(offset))
      if (opener) {
        activeFence = { ...opener, quoteDepth, containerIndent: baseIndent }
        sanitized += appendNewline
        lineStart = index + 1
        continue
      }
      const container = detectContainerLine(lineWithoutQuote, columns, offset, baseIndent)
      if (container) {
        if (container.contentIndent > baseIndent) {
          containers.push({ quoteDepth, indent: container.contentIndent })
        }
        const inlineOpener = matchFenceOpener(container.remainder)
        if (inlineOpener) {
          activeFence = { ...inlineOpener, quoteDepth, containerIndent: container.contentIndent }
          sanitized += appendNewline
          lineStart = index + 1
          continue
        }
      }
    }

    sanitized += stripInlineCodeSpans(line) + appendNewline
    if (lastCommentClose !== -1 && (isBlank || columns <= baseIndent + 3)) {
      inHtmlComment = advanceHtmlCommentStateOnLine(
        lineWithoutQuote,
        lineStart + prefixLength,
        false,
        lastCommentClose
      )
    }
    lineStart = index + 1
  }

  return sanitized
}
