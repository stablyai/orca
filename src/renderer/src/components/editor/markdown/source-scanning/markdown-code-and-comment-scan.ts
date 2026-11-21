function isEscaped(content: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

export function countBlockquoteDepth(prefix: string): number {
  let depth = 0
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix.charCodeAt(i) === 62) {
      depth += 1
    }
  }
  return depth
}

/** Matches a CommonMark exact-length backtick run; returns the end index or -1 if unclosed. */
function findInlineCodeSpanEnd(line: string, start: number): number {
  let tickCount = 0
  while (line[start + tickCount] === '`') {
    tickCount += 1
  }
  if (tickCount === 0) {
    return -1
  }
  const delimiter = '`'.repeat(tickCount)
  let searchFrom = start + tickCount
  while (searchFrom < line.length) {
    const candidate = line.indexOf(delimiter, searchFrom)
    if (candidate === -1) {
      return -1
    }
    if ((candidate === 0 || line[candidate - 1] !== '`') && line[candidate + tickCount] !== '`') {
      return candidate + tickCount
    }
    searchFrom = candidate + 1
  }
  return -1
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

/** Removes fenced code blocks (including inside blockquotes) and inline code spans while keeping line breaks. */
export function stripMarkdownCode(content: string): string {
  let sanitized = ''
  let activeFence: { marker: '`' | '~'; length: number; quoteDepth: number } | null = null
  let lineStart = 0

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const index = newlineIndex === -1 ? content.length : newlineIndex
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    const quoteMatch = line.match(/^(?:[ \t]*>[ \t]?)+/)
    const quoteDepth = quoteMatch ? countBlockquoteDepth(quoteMatch[0]) : 0
    const lineWithoutQuote = quoteMatch ? line.slice(quoteMatch[0].length) : line

    if (activeFence && activeFence.quoteDepth > 0 && quoteDepth < activeFence.quoteDepth) {
      activeFence = null
    }

    const fenceMatch = lineWithoutQuote.match(/^[ \t]*(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] === '~' ? '~' : '`'
      const length = fenceMatch[1].length
      const trailing = fenceMatch[2]
      if (activeFence === null) {
        if (marker === '~' || !trailing.includes('`')) {
          activeFence = { marker, length, quoteDepth }
        } else {
          sanitized += stripInlineCodeSpans(line)
        }
      } else if (
        activeFence.marker === marker &&
        length >= activeFence.length &&
        /^[ \t]*$/.test(trailing)
      ) {
        activeFence = null
      }
    } else if (!activeFence) {
      sanitized += stripInlineCodeSpans(line)
    }

    if (index < content.length) {
      sanitized += '\n'
    }
    lineStart = index + 1
  }

  return sanitized
}

export function advanceHtmlCommentStateOnLine(
  line: string,
  lineStartOffset: number,
  inComment: boolean,
  lastCommentClose: number
): boolean {
  let comment = inComment
  let index = 0
  while (index < line.length) {
    if (comment) {
      const closeIndex = line.indexOf('-->', index)
      if (closeIndex === -1) {
        return true
      }
      comment = false
      index = closeIndex + 3
      continue
    }

    if (line[index] === '`') {
      const spanEnd = findInlineCodeSpanEnd(line, index)
      if (spanEnd !== -1) {
        index = spanEnd
        continue
      }
      while (line[index] === '`') {
        index += 1
      }
      continue
    }

    if (
      line.startsWith('<!--', index) &&
      !isEscaped(line, index) &&
      lineStartOffset + index + 4 <= lastCommentClose
    ) {
      comment = true
      index += 4
      continue
    }

    index += 1
  }
  return comment
}

/** Mask closed HTML comments while preserving line breaks and avoiding column-0 shifts. */
export function stripClosedHtmlComments(contentWithoutCode: string): string {
  const lastCommentClose = contentWithoutCode.lastIndexOf('-->')
  if (lastCommentClose === -1 || !contentWithoutCode.includes('<!--')) {
    return contentWithoutCode
  }
  let output = ''
  let index = 0
  while (index < contentWithoutCode.length) {
    if (
      contentWithoutCode.startsWith('<!--', index) &&
      !isEscaped(contentWithoutCode, index) &&
      index + 4 <= lastCommentClose
    ) {
      const closeIndex = contentWithoutCode.indexOf('-->', index + 4)
      if (closeIndex !== -1) {
        const commentEnd = closeIndex + 3
        let newlineCount = 0
        for (let cursor = index; cursor < commentEnd; cursor += 1) {
          if (contentWithoutCode.charCodeAt(cursor) === 10) {
            newlineCount += 1
          }
        }
        output += newlineCount === 0 ? 'x' : `x${'\n'.repeat(newlineCount)}x`
        index = commentEnd
        continue
      }
    }
    output += contentWithoutCode[index]
    index += 1
  }
  return output
}
