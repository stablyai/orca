import type { editor as monacoEditor } from 'monaco-editor'

type DiffCommentPopoverEditor = Pick<
  monacoEditor.ICodeEditor,
  'getModel' | 'getScrollTop' | 'getTopForLineNumber'
>

type DiffCommentPopoverLeftEditor = Pick<monacoEditor.ICodeEditor, 'getDomNode' | 'getLayoutInfo'>

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

export function getDiffCommentPopoverLeft(
  editor: DiffCommentPopoverLeftEditor,
  offsetParent: HTMLElement | null
): number | null {
  const editorDomNode = editor.getDomNode()
  if (!editorDomNode || !offsetParent) {
    return null
  }
  const editorRect = editorDomNode.getBoundingClientRect()
  const parentRect = offsetParent.getBoundingClientRect()
  // Why: saved notes live in Monaco view zones, which start at the editor
  // content column. The popover is a React sibling overlay, so it must add the
  // editor pane's offset before applying Monaco's contentLeft.
  return Math.max(
    0,
    Math.round(editorRect.left - parentRect.left + editor.getLayoutInfo().contentLeft)
  )
}
