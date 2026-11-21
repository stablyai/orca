import {
  advanceContainerStackForLine,
  countBlockquoteDepth,
  matchContainerContinuation,
  stripBlockquoteLevels,
  type MarkdownContainer
} from './markdown-block-container'
import { stripInlineCodeSpansPreservingComments } from './markdown-html-comment-scan'

export { countBlockquoteDepth, stripBlockquoteLevels }

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

/** Removes fenced code blocks (respecting blockquotes, list/footnote indentation, and HTML comments) and inline code spans. */
export function stripMarkdownCode(content: string): string {
  const lastCommentClose = content.lastIndexOf('-->')
  const containers: MarkdownContainer[] = []
  let activeFence: {
    marker: '`' | '~'
    length: number
    quoteDepth: number
    containerIndent: number
  } | null = null
  let activeHtmlComment: {
    quoteDepth: number
    containerIndent: number
  } | null = null
  let sanitized = ''
  let lineStart = 0

  while (lineStart <= content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const index = newlineIndex === -1 ? content.length : newlineIndex
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    const line = content.slice(lineStart, lineEnd)
    const appendNewline = index < content.length ? '\n' : ''

    if (activeFence !== null) {
      const continuation = matchContainerContinuation(
        line,
        activeFence.quoteDepth,
        activeFence.containerIndent
      )
      if (continuation !== null) {
        if (
          !continuation.isBlank &&
          isMatchingFenceCloser(
            continuation.containerLine,
            continuation.columns,
            continuation.offset,
            activeFence
          )
        ) {
          activeFence = null
        }
        sanitized += appendNewline
        lineStart = index + 1
        continue
      }
      activeFence = null
    }

    if (activeHtmlComment !== null) {
      const continuation = matchContainerContinuation(
        line,
        activeHtmlComment.quoteDepth,
        activeHtmlComment.containerIndent
      )
      if (continuation !== null) {
        const strippedPrefixLength = line.length - continuation.containerLine.length
        const commentScan = stripInlineCodeSpansPreservingComments(
          continuation.containerLine,
          lineStart + strippedPrefixLength,
          true,
          lastCommentClose,
          lastCommentClose !== -1
        )
        sanitized += line.slice(0, strippedPrefixLength) + commentScan.sanitized + appendNewline
        if (!commentScan.inComment) {
          activeHtmlComment = null
        }
        lineStart = index + 1
        continue
      }
      activeHtmlComment = null
    }

    const state = advanceContainerStackForLine(containers, line)
    if (!state.isBlank && state.columns <= state.baseIndent + 3) {
      const opener = matchFenceOpener(state.lineWithoutQuote.slice(state.offset))
      if (opener) {
        activeFence = { ...opener, quoteDepth: state.quoteDepth, containerIndent: state.baseIndent }
        sanitized += appendNewline
        lineStart = index + 1
        continue
      }
      if (state.container && !state.container.startsIndentedCode) {
        const inlineOpener = matchFenceOpener(state.container.remainder)
        if (inlineOpener) {
          activeFence = {
            ...inlineOpener,
            quoteDepth: state.quoteDepth,
            containerIndent: state.container.contentIndent
          }
          sanitized += appendNewline
          lineStart = index + 1
          continue
        }
      }
    }

    const allowCommentOpen =
      lastCommentClose !== -1 &&
      (state.isBlank || state.columns <= state.baseIndent + 3) &&
      !(state.container?.startsIndentedCode ?? false)
    const commentScan = stripInlineCodeSpansPreservingComments(
      state.lineWithoutQuote,
      lineStart + state.prefixLength,
      false,
      lastCommentClose,
      allowCommentOpen
    )
    sanitized += line.slice(0, state.prefixLength) + commentScan.sanitized + appendNewline
    if (commentScan.inComment) {
      activeHtmlComment = {
        quoteDepth: state.quoteDepth,
        containerIndent: state.effectiveIndent
      }
    }
    lineStart = index + 1
  }

  return sanitized
}
