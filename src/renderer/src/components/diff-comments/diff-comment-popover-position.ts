import type { editor as monacoEditor } from 'monaco-editor'

type DiffCommentPopoverEditor = Pick<
  monacoEditor.ICodeEditor,
  'getModel' | 'getScrollTop' | 'getTopForLineNumber'
>

const FALLBACK_LINE_HEIGHT_PX = 19

export function getDiffCommentPopoverTop(
  editor: DiffCommentPopoverEditor,
  lineNumber: number,
  lineHeight: unknown
): number | null {
  const model = editor.getModel()
  if (!model) {
    return null
  }
  if (lineNumber < 1 || lineNumber > model.getLineCount()) {
    return null
  }
  const resolvedLineHeight =
    typeof lineHeight === 'number' && lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT_PX
  return editor.getTopForLineNumber(lineNumber) - editor.getScrollTop() + resolvedLineHeight
}
