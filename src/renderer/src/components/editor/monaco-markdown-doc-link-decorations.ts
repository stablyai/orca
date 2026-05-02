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

  content.split('\n').forEach((line, lineIndex) => {
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
            startLineNumber: lineIndex + 1,
            startColumn: start + 1,
            endLineNumber: lineIndex + 1,
            endColumn: end + 3
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

export function createMarkdownDocLinkDecorationController(
  editorInstance: editor.IStandaloneCodeEditor,
  getLanguage: () => string
): MarkdownDocLinkDecorationController {
  const collection = editorInstance.createDecorationsCollection()

  const refresh = (): void => {
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

  const listener: IDisposable = editorInstance.onDidChangeModelContent(refresh)
  refresh()

  return {
    refresh,
    dispose: () => {
      listener.dispose()
      collection.clear()
    }
  }
}
