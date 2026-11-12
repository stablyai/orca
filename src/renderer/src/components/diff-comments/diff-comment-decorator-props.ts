import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { editor as monacoEditor } from 'monaco-editor'
import type { DiffCommentFileSession } from './diff-comment-session'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import type { DiffCommentLineTarget } from './diff-comment-line-range'

export type DiffCommentDecoratorArgs = {
  session?: DiffCommentFileSession
  captureCreateComment?: boolean
  commentOwner?: DiffCommentOwner | null
  editor: monacoEditor.ICodeEditor | null
  // Monaco destroys model-scoped view zones on model swap, so rebuild even though the editor object is stable.
  monacoModelIdentity?: string
  filePath: string
  worktreeId: string
  comments: readonly DecoratedDiffComment[]
  commentableLineNumbers?: readonly number[]
  addButtonLabel?: string
  pendingCommentTarget?: DiffCommentLineTarget | null
  // Markdown editors already bind this chord through their input bindings.
  addNoteShortcutEnabled?: boolean
  onCreateComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  imageUploadAddress?: GitHubImageIntake['address']
  draftPlaceholder?: string
  draftSubmitLabel?: string
  canOpenDraft?: boolean
  onAddCommentClick?: (args: { lineNumber: number; startLine?: number; top: number }) => void
  onDeleteComment: (commentId: string) => void
  // Present only on surfaces that allow editing (local diffs); PR review notes are remote and can't be edited here.
  onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  // Pending scroll-to-note id from the sidebar; decorator reveals the line and acks so the same id can be re-requested later.
  pendingScrollCommentId?: string | null
  onPendingScrollConsumed?: (id: string) => void
}
