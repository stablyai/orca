import type { IRange } from 'monaco-editor'

const FALLBACK_LINE_HEIGHT_PX = 19

export type MonacoMarkdownSelectionAnnotationTarget = {
  lineNumber: number
  startLine?: number
  selectedText: string
  top: number
  left?: number
}

type MonacoMarkdownSelectionModel = {
  getLineCount: () => number
  getValueInRange: (range: IRange) => string
}

type MonacoMarkdownSelectionEditor = {
  getModel: () => MonacoMarkdownSelectionModel | null
  getScrollTop: () => number
  getTopForLineNumber: (lineNumber: number) => number
}

function isEmptySelection(selection: IRange): boolean {
  return (
    selection.startLineNumber === selection.endLineNumber &&
    selection.startColumn === selection.endColumn
  )
}

function getSelectionTextEndLine(selection: IRange): number {
  if (selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber) {
    return selection.endLineNumber - 1
  }
  return selection.endLineNumber
}

export function getMonacoMarkdownSelectionAnnotationTarget(
  editorInstance: MonacoMarkdownSelectionEditor,
  selection: IRange | null,
  left?: number
): MonacoMarkdownSelectionAnnotationTarget | null {
  if (!selection || isEmptySelection(selection)) {
    return null
  }
  const model = editorInstance.getModel()
  if (!model) {
    return null
  }
  const selectedText = model.getValueInRange(selection).trim()
  if (!selectedText) {
    return null
  }
  const textEndLine = getSelectionTextEndLine(selection)
  const startLine = Math.min(selection.startLineNumber, textEndLine)
  const lineNumber = Math.max(selection.startLineNumber, textEndLine)
  if (startLine < 1 || lineNumber > model.getLineCount()) {
    return null
  }
  const top =
    editorInstance.getTopForLineNumber(lineNumber) -
    editorInstance.getScrollTop() +
    FALLBACK_LINE_HEIGHT_PX
  return {
    lineNumber,
    startLine: startLine === lineNumber ? undefined : startLine,
    selectedText,
    top,
    left
  }
}
