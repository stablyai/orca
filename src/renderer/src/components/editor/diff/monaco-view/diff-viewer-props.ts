import type { WorkspaceResource } from '@/lib/workspace-copy-owner'
import type { LargeDiffRenderLimit } from '../../../../../../shared/large-diff-render-limit'

export type DiffViewerProps = {
  modelKey: string
  /** Open-file ID that owns the models, so closing the file releases every view scope. */
  modelOwnerKey?: string
  originalModelKey?: string
  modifiedModelKey?: string
  originalContent: string
  modifiedContent: string
  language: string
  filePath: string
  relativePath: string
  sideBySide: boolean
  editable?: boolean
  // Hosted review dialogs may have no workspace for local comments.
  worktreeId?: string
  /** The diff's tab; its review notes belong to the copy it names. */
  noteSource?: WorkspaceResource
  onAddLineComment?: (args: {
    lineNumber: number
    startLine?: number
    body: string
  }) => Promise<boolean>
  commentableLineNumbers?: readonly number[]
  addLineCommentLabel?: string
  addLineCommentPlaceholder?: string
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void
  largeDiffRenderLimit?: LargeDiffRenderLimit
  // Render-limited IPC bodies are blank placeholders, never saveable drafts.
  largeDiffSaveContentAvailable?: boolean
}
