import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-provenance'

export type MarkdownPreviewProps = {
  content: string
  filePath: string
  sourceFileId?: string | null
  sourceWorktreeId?: string | null
  /** Workspace-relative path of the previewed file, as the editor names it. */
  sourceRelativePath?: string | null
  sourceRuntimeEnvironmentId?: string | null
  scrollCacheKey: string
  initialAnchor?: string | null
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  markdownDocuments?: MarkdownDocument[]
  onOpenDocument?: (
    document: MarkdownDocument,
    options?: { anchor?: string | null }
  ) => void | Promise<void>
  markdownAnnotationsEnabled?: boolean
}

export type MarkdownPreviewPositionNode = {
  tagName?: string
  position?: {
    start?: { line?: number }
    end?: { line?: number }
  }
  children?: MarkdownPreviewPositionNode[]
}

export type MarkdownPreviewSourceOpenFile = {
  id: string
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string
  operationProvenance?: EditorFileOperationProvenance
  mode: string
  markdownPreviewSourceFileId?: string
}

export type MarkdownPreviewBlockRange = {
  startLine: number
  endLine: number
}
