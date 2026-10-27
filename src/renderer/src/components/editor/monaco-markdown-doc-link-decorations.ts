import type { editor, IDisposable, IRange } from 'monaco-editor'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'
import { createMarkdownFenceRangeCursor, getMarkdownFenceRanges } from './markdown-fence-scanner'
import { forEachLine } from './text-line-offsets'

const BACKTICK = 96
const BACKSLASH = 92

// Reuse flat offset pairs to avoid allocating an object per span during whole-document scans.
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

export function getMarkdownDocLinkDecorationRanges(content: string): IRange[] {
  const ranges: IRange[] = []
  const inlineCodeSpans: number[] = []
  const isInsideFence = createMarkdownFenceRangeCursor(getMarkdownFenceRanges(content))
  // Advance delimiter cursors monotonically to avoid rescanning each line’s remaining document tail.
  let nextOpen = content.indexOf('[[')
  let nextClose = content.indexOf(']]')

  forEachLine(content, (lineStart, lineEnd, lineNumber) => {
    if (isInsideFence(lineStart)) {
      return
    }

    let spansCollected = false
    let spanCursor = 0
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
      // Most lines have no wiki links; defer code-span scanning until a link is found.
      if (!spansCollected) {
        collectInlineCodeSpans(content, lineStart, lineEnd, inlineCodeSpans)
        spansCollected = true
      }
      // Why: spans and link offsets are ordered, so each span needs only one forward visit.
      while (spanCursor < inlineCodeSpans.length && inlineCodeSpans[spanCursor + 1] <= start) {
        spanCursor += 2
      }
      if (spanCursor >= inlineCodeSpans.length || start < inlineCodeSpans[spanCursor]) {
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
    // Coalesce whole-model decoration scans; highlights may briefly lag rather than rescan on every key.
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
