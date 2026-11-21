import {
  advanceContainerStackForLine,
  matchContainerContinuation,
  type MarkdownContainer
} from './markdown-block-container'

function isEscaped(content: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

/** Matches a CommonMark exact-length backtick run; returns the end index or -1 if unclosed. */
export function findInlineCodeSpanEnd(line: string, start: number): number {
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

/** Strips inline code spans while preserving literal backticks inside HTML comments. */
export function stripInlineCodeSpansPreservingComments(
  line: string,
  lineStartOffset: number,
  inComment: boolean,
  lastCommentClose: number,
  allowCommentOpen: boolean
): { sanitized: string; inComment: boolean } {
  let comment = inComment
  if (!comment && !line.includes('`') && (!allowCommentOpen || !line.includes('<!--'))) {
    return { sanitized: line, inComment: false }
  }
  let sanitized = ''
  let index = 0
  while (index < line.length) {
    if (comment) {
      const closeIndex = line.indexOf('-->', index)
      if (closeIndex === -1) {
        sanitized += line.slice(index)
        return { sanitized, inComment: true }
      }
      sanitized += line.slice(index, closeIndex + 3)
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
      let tickCount = 0
      while (line[index + tickCount] === '`') {
        tickCount += 1
      }
      sanitized += line.slice(index, index + tickCount)
      index += tickCount
      continue
    }

    if (
      allowCommentOpen &&
      line.startsWith('<!--', index) &&
      !isEscaped(line, index) &&
      lineStartOffset + index + 4 <= lastCommentClose
    ) {
      sanitized += '<!--'
      comment = true
      index += 4
      continue
    }

    sanitized += line[index]
    index += 1
  }
  return { sanitized, inComment: comment }
}

function getLineBounds(
  content: string,
  lineStart: number
): { lineEnd: number; nextLineStart: number } {
  const newlineIndex = content.indexOf('\n', lineStart)
  const rawEnd = newlineIndex === -1 ? content.length : newlineIndex
  const lineEnd = rawEnd > lineStart && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd
  return { lineEnd, nextLineStart: newlineIndex === -1 ? content.length : newlineIndex + 1 }
}

function findCommentCloseInContainer(
  content: string,
  startLineOffset: number,
  quoteDepth: number,
  containerIndent: number
): {
  closeLineStart: number
  closeLineEnd: number
  closeNextLineStart: number
  closeOffsetInLine: number
  newlineCount: number
} | null {
  let scanStart = startLineOffset
  let newlineCount = 0
  while (scanStart < content.length) {
    newlineCount += 1
    const { lineEnd, nextLineStart } = getLineBounds(content, scanStart)
    const scanLine = content.slice(scanStart, lineEnd)
    const continuation = matchContainerContinuation(scanLine, quoteDepth, containerIndent)
    if (continuation === null) {
      return null
    }
    const closeInContainer = continuation.containerLine.indexOf('-->')
    if (closeInContainer !== -1) {
      const strippedPrefixLength = scanLine.length - continuation.containerLine.length
      return {
        closeLineStart: scanStart,
        closeLineEnd: lineEnd,
        closeNextLineStart: nextLineStart,
        closeOffsetInLine: strippedPrefixLength + closeInContainer + 3,
        newlineCount
      }
    }
    if (nextLineStart <= scanStart || lineEnd === content.length) {
      break
    }
    scanStart = nextLineStart
  }
  return null
}

/** Mask closed HTML comments within their container while preserving line breaks and column-0 alignment. */
export function stripClosedHtmlComments(contentWithoutCode: string): string {
  const lastCommentClose = contentWithoutCode.lastIndexOf('-->')
  if (lastCommentClose === -1 || !contentWithoutCode.includes('<!--')) {
    return contentWithoutCode
  }
  const containers: MarkdownContainer[] = []
  let output = ''
  let lineStart = 0

  while (lineStart < contentWithoutCode.length) {
    let { lineEnd, nextLineStart } = getLineBounds(contentWithoutCode, lineStart)
    let line = contentWithoutCode.slice(lineStart, lineEnd)
    let newline = contentWithoutCode.slice(lineEnd, nextLineStart)
    const state = advanceContainerStackForLine(containers, line)
    const allowCommentOpen =
      (state.isBlank || state.columns <= state.baseIndent + 3) &&
      !(state.container?.startsIndentedCode ?? false)

    if (!allowCommentOpen || !line.includes('<!--')) {
      output += line + newline
      if (nextLineStart <= lineStart || lineEnd === contentWithoutCode.length) {
        break
      }
      lineStart = nextLineStart
      continue
    }

    output += line.slice(0, state.prefixLength)
    let cursor = state.prefixLength
    while (cursor < line.length) {
      const openIndex = line.indexOf('<!--', cursor)
      if (openIndex === -1) {
        output += line.slice(cursor)
        break
      }
      output += line.slice(cursor, openIndex)
      if (isEscaped(line, openIndex) || lineStart + openIndex + 4 > lastCommentClose) {
        output += '<!--'
        cursor = openIndex + 4
        continue
      }
      const sameLineClose = line.indexOf('-->', openIndex + 4)
      if (sameLineClose !== -1) {
        output += 'x'
        cursor = sameLineClose + 3
        continue
      }
      const multilineClose =
        lineEnd < contentWithoutCode.length
          ? findCommentCloseInContainer(
              contentWithoutCode,
              nextLineStart,
              state.quoteDepth,
              state.effectiveIndent
            )
          : null
      if (!multilineClose) {
        output += '<!--'
        cursor = openIndex + 4
        continue
      }
      output += `x${'\n'.repeat(multilineClose.newlineCount)}x`
      lineStart = multilineClose.closeLineStart
      lineEnd = multilineClose.closeLineEnd
      nextLineStart = multilineClose.closeNextLineStart
      line = contentWithoutCode.slice(lineStart, lineEnd)
      newline = contentWithoutCode.slice(lineEnd, nextLineStart)
      cursor = multilineClose.closeOffsetInLine
    }
    output += newline
    if (nextLineStart <= lineStart || lineEnd === contentWithoutCode.length) {
      break
    }
    lineStart = nextLineStart
  }

  return output
}
