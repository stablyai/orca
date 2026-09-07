import type { editor, IDisposable, IRange } from 'monaco-editor'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'
import { forEachLine } from './text-line-offsets'

const BACKTICK = 96
const BACKSLASH = 92

// Why: spans are stored as flat [start, end, start, end, …] absolute offsets so
// a full-document scan allocates one reusable array instead of an object per span.
function collectInlineCodeSpans(
  content: string,
  lineStart: number,
  lineEnd: number,
  spans: number[]
): void {
  spans.length = 0
  let start = -1

  for (let index = lineStart; index < lineEnd; index += 1) {
    if (
      content.charCodeAt(index) !== BACKTICK ||
      (index > lineStart && content.charCodeAt(index - 1) === BACKSLASH)
    ) {
      continue
    }
    if (start === -1) {
      start = index
    } else {
      spans.push(start, index + 1)
      start = -1
    }
  }
}

function isInsideSpan(index: number, spans: number[]): boolean {
  for (let cursor = 0; cursor < spans.length; cursor += 2) {
    if (index >= spans[cursor] && index < spans[cursor + 1]) {
      return true
    }
  }
  return false
}

const FENCE_PREFIX_RE = /\s*(?:```|~~~)/y

function startsCodeFence(content: string, lineStart: number, lineEnd: number): boolean {
  FENCE_PREFIX_RE.lastIndex = lineStart
  // Why: a sticky `\s*` run can cross the newline into the next line, so an
  // out-of-line match is rejected to stay identical to the old per-line regex.
  return FENCE_PREFIX_RE.test(content) && FENCE_PREFIX_RE.lastIndex <= lineEnd
}

export function getMarkdownDocLinkDecorationRanges(content: string): IRange[] {
  const ranges: IRange[] = []
  const inlineCodeSpans: number[] = []
  let insideFence = false
  // Why: `indexOf` on the whole document would rescan the tail once per line.
  // Both cursors only ever move forward, and every probe position is
  // monotonic, so the delimiter search stays linear in document length.
  let nextOpen = content.indexOf('[[')
  let nextClose = content.indexOf(']]')

  forEachLine(content, (lineStart, lineEnd, lineNumber) => {
    if (startsCodeFence(content, lineStart, lineEnd)) {
      insideFence = !insideFence
      return
    }
    if (insideFence) {
      return
    }

    let spansCollected = false
    let searchFrom = lineStart
    while (searchFrom < lineEnd) {
      if (nextOpen !== -1 && nextOpen < searchFrom) {
        nextOpen = content.indexOf('[[', searchFrom)
      }
      const start = nextOpen
      if (start === -1 || start + 2 > lineEnd) {
        break
      }
      if (nextClose !== -1 && nextClose < start + 2) {
        nextClose = content.indexOf(']]', start + 2)
      }
      const end = nextClose
      if (end === -1 || end + 2 > lineEnd) {
        break
      }
      // Why: most lines hold no wiki link, so the inline-code scan is deferred
      // until one is actually found.
      if (!spansCollected) {
        collectInlineCodeSpans(content, lineStart, lineEnd, inlineCodeSpans)
        spansCollected = true
      }
      if (!isInsideSpan(start, inlineCodeSpans)) {
        const target = getMarkdownDocLinkTarget(content.slice(start + 2, end))
        if (target) {
          ranges.push({
            startLineNumber: lineNumber,
            startColumn: start - lineStart + 1,
            endLineNumber: lineNumber,
            endColumn: end - lineStart + 3
          })
        }
      }
      searchFrom = end + 2
    }
  })

  return ranges
}

export type MarkdownDocLinkDecorationController = {
  refresh: () => void
  dispose: () => void
}

export const MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS = 120

export function createMarkdownDocLinkDecorationController(
  editorInstance: editor.IStandaloneCodeEditor,
  getLanguage: () => string
): MarkdownDocLinkDecorationController {
  const collection = editorInstance.createDecorationsCollection()
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  const cancelPendingRefresh = (): void => {
    if (refreshTimer === null) {
      return
    }
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  const refreshNow = (): void => {
    cancelPendingRefresh()
    const model = editorInstance.getModel()
    if (!model || getLanguage() !== 'markdown') {
      collection.clear()
      return
    }
    collection.set(
      getMarkdownDocLinkDecorationRanges(model.getValue()).map((range) => ({
        range,
        options: {
          inlineClassName: 'monaco-markdown-doc-link',
          stickiness: 1
        }
      }))
    )
  }

  const refresh = (): void => {
    if (getLanguage() !== 'markdown') {
      refreshNow()
      return
    }
    cancelPendingRefresh()
    // Why: wiki-link decoration scans read the full Monaco model. During typing
    // the exact highlight can lag briefly; coalescing avoids one full scan per key.
    refreshTimer = setTimeout(refreshNow, MARKDOWN_DOC_LINK_DECORATION_REFRESH_DELAY_MS)
  }

  const listener: IDisposable = editorInstance.onDidChangeModelContent(refresh)
  refreshNow()

  return {
    refresh,
    dispose: () => {
      cancelPendingRefresh()
      listener.dispose()
      collection.clear()
    }
  }
}
