import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { useDiffCommentDecorator } from '../diff-comments/useDiffCommentDecorator'
import { getDiffCommentPopoverLeft } from '../diff-comments/diff-comment-popover-position'

export function useDiffCommentDecoratorConfig({
  hasLineCommentAction,
  modifiedEditor,
  relativePath,
  worktreeId,
  allComments,
  commentableLineNumbers,
  addLineCommentLabel,
  deleteDiffComment,
  updateDiffComment,
  pendingScrollForThisViewer,
  setScrollToDiffCommentId,
  diffBodyRef,
  setPopover
}: {
  hasLineCommentAction: boolean
  modifiedEditor: editor.ICodeEditor | null
  relativePath: string
  worktreeId: string | undefined
  allComments: {
    id: string
    lineNumber: number
    startLine?: number
    body: string
  }[]
  commentableLineNumbers: Set<number> | undefined
  addLineCommentLabel: string | undefined
  deleteDiffComment: (worktreeId: string, id: string) => void
  updateDiffComment: (worktreeId: string, id: string, body: string) => void
  pendingScrollForThisViewer: string | null
  setScrollToDiffCommentId: (id: string | null) => void
  diffBodyRef: React.RefObject<HTMLDivElement | null>
  setPopover: React.Dispatch<
    React.SetStateAction<{
      lineNumber: number
      startLine?: number
      top: number
      left?: number
      lineHeight: number
    } | null>
  >
}): void {
  // Why: gate the decorator on having a comment target. Local diffs persist
  // notes to worktree metadata; GitHub PR diffs post line comments remotely.
  // updateDiffComment is only wired for local diffs (worktreeId present).
  useDiffCommentDecorator({
    editor: hasLineCommentAction ? modifiedEditor : null,
    filePath: relativePath,
    worktreeId: worktreeId ?? '',
    comments: worktreeId ? allComments : [],
    commentableLineNumbers,
    addButtonLabel: addLineCommentLabel,
    onAddCommentClick: ({ lineNumber, startLine, top }) =>
      setPopover({
        lineNumber,
        startLine,
        top,
        left: modifiedEditor
          ? (getDiffCommentPopoverLeft(modifiedEditor, diffBodyRef.current) ?? undefined)
          : undefined,
        lineHeight: modifiedEditor?.getOption(monaco.editor.EditorOption.lineHeight) ?? 0
      }),
    onDeleteComment: (id) => {
      if (worktreeId) {
        void deleteDiffComment(worktreeId, id)
      }
    },
    onUpdateComment: worktreeId ? (id, body) => updateDiffComment(worktreeId, id, body) : undefined,
    pendingScrollCommentId: pendingScrollForThisViewer,
    onPendingScrollConsumed: () => setScrollToDiffCommentId(null)
  })
}
