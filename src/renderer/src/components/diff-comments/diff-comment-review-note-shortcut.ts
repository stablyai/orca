import * as monaco from 'monaco-editor'
import type { editor as monacoEditor } from 'monaco-editor'
import { installEditorAddReviewNoteShortcut } from '../editor/editor-shortcuts'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'

type DiffCommentShortcutTarget = {
  lineNumber: number
  startLine?: number
  top: number
}

type InstallDiffCommentReviewNoteShortcutArgs = {
  editor: monacoEditor.ICodeEditor
  editorDomNode: HTMLElement
  commentableLineSet: ReadonlySet<number> | null
  isDraftOpen: () => boolean
  onAddComment: (target: DiffCommentShortcutTarget) => void
}

function getSelectionEndLine(selection: monaco.Selection): number {
  if (
    selection.endColumn === 1 &&
    selection.endLineNumber > selection.startLineNumber &&
    !selection.isEmpty()
  ) {
    return selection.endLineNumber - 1
  }
  return selection.endLineNumber
}

function isCommentableRange(
  commentableLineSet: ReadonlySet<number> | null,
  startLine: number,
  endLine: number
): boolean {
  if (commentableLineSet === null) {
    return true
  }
  for (let line = startLine; line <= endLine; line++) {
    if (!commentableLineSet.has(line)) {
      return false
    }
  }
  return true
}

export function getDiffCommentShortcutTarget(
  editor: monacoEditor.ICodeEditor,
  commentableLineSet: ReadonlySet<number> | null
): DiffCommentShortcutTarget | null {
  const selection = editor.getSelection()
  const position = editor.getPosition()
  if (!selection && !position) {
    return null
  }
  const startLine = selection?.startLineNumber ?? position?.lineNumber
  const lineNumber = selection ? getSelectionEndLine(selection) : position?.lineNumber
  if (
    startLine === undefined ||
    lineNumber === undefined ||
    !isCommentableRange(commentableLineSet, startLine, lineNumber)
  ) {
    return null
  }
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
  const top = getDiffCommentPopoverTop(editor, lineNumber, lineHeight)
  if (top === null) {
    return null
  }
  return {
    lineNumber,
    startLine: startLine === lineNumber ? undefined : startLine,
    top
  }
}

export function installDiffCommentReviewNoteShortcut({
  editor,
  editorDomNode,
  commentableLineSet,
  isDraftOpen,
  onAddComment
}: InstallDiffCommentReviewNoteShortcutArgs): () => void {
  return installEditorAddReviewNoteShortcut(editorDomNode, () => {
    if (isDraftOpen()) {
      return true
    }
    const target = getDiffCommentShortcutTarget(editor, commentableLineSet)
    if (!target) {
      return false
    }
    onAddComment(target)
    return true
  })
}
