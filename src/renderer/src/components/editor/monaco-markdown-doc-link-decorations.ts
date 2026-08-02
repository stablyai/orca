import type { editor, IDisposable, IRange } from 'monaco-editor'
import { getMarkdownDocLinkTarget } from './markdown-doc-links'

function getInlineCodeSpans(line: string): { start: number; end: number }[] {
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

function isInsideSpan(index: number, spans: { start: number; end: number }[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end)
}

export function getMarkdownDocLinkDecorationRanges(content: string): IRange[] {
  const ranges: IRange[] = []
  let insideFence = false

  forEachMarkdownLine(content, (line, lineNumber) => {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      return
    }
    if (insideFence) {
      return
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
            startLineNumber: lineNumber,
            startColumn: start + 1,
            endLineNumber: lineNumber,
            endColumn: end + 3
          })
        }
      }
      searchFrom = end + 2
    }
  })

  return ranges
}

function forEachMarkdownLine(
  content: string,
  visit: (line: string, lineNumber: number) => void
): void {
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    visit(content.slice(lineStart, lineEnd), lineNumber)
    lineStart = index + 1
    lineNumber += 1
  }
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
