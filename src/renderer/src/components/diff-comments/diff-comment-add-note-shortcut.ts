import * as monaco from 'monaco-editor'
import type { editor as monacoEditor, Selection } from 'monaco-editor'
import { installEditorAddReviewNoteShortcut } from '../editor/editor-shortcuts'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'
import {
  clampFocusLineToCommentable,
  getSelectionAnchorFocus,
  orderLineRange,
  toDiffCommentLineTarget,
  type DiffCommentLineTarget
} from './diff-comment-line-range'

// Why: the "+" button is mouse-only (it exists only under the cursor), so the bindable
// Add Review Note chord is the keyboard path into the same composer — and because it reads the
// editor's selection, shift+arrow then chord is the keyboard multi-line select.

type AddNoteShortcutEditor = Pick<
  monacoEditor.ICodeEditor,
  | 'getContainerDomNode'
  | 'getModel'
  | 'getOption'
  | 'getScrollTop'
  | 'getSelection'
  | 'getTopForLineNumber'
>

export function resolveDiffCommentShortcutTarget(
  selection: Selection | null,
  commentableLineSet: ReadonlySet<number> | null
): DiffCommentLineTarget | null {
  if (!selection) {
    return null
  }
  const { anchorLine, focusLine } = getSelectionAnchorFocus(selection)
  if (commentableLineSet !== null && !commentableLineSet.has(anchorLine)) {
    return null
  }
  return toDiffCommentLineTarget(
    orderLineRange(
      anchorLine,
      clampFocusLineToCommentable(anchorLine, focusLine, commentableLineSet)
    )
  )
}

export function installDiffCommentAddNoteShortcut({
  editor,
  commentableLineSet,
  isComposerOpen,
  onOpenComposer
}: {
  editor: AddNoteShortcutEditor
  commentableLineSet: ReadonlySet<number> | null
  isComposerOpen: () => boolean
  onOpenComposer: (args: { lineNumber: number; startLine?: number; top: number }) => void
}): () => void {
  return installEditorAddReviewNoteShortcut(editor.getContainerDomNode(), () => {
    // Why: an open draft consumes the chord itself (DiffCommentPopover's guard); claiming it here
    // too would remount the composer and drop what the user already typed.
    if (isComposerOpen()) {
      return true
    }
    const target = resolveDiffCommentShortcutTarget(editor.getSelection(), commentableLineSet)
    if (!target) {
      return false
    }
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
    const top = getDiffCommentPopoverTop(editor, target.lineNumber, lineHeight)
    if (top == null) {
      return false
    }
    onOpenComposer({ ...target, top })
    return true
  })
}
