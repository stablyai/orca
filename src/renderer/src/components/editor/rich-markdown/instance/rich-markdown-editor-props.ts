import type React from 'react'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-provenance'

export type RichMarkdownEditorProps = {
  fileId: string
  viewStateId: string
  content: string
  filePath: string
  worktreeId: string
  externalSshTargetId?: string
  runtimeEnvironmentId?: string | null
  /** The tab's captured owner; with the fields above it names the copy whose notes show. */
  operationProvenance?: EditorFileOperationProvenance
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => void
  onOpenDocLink?: (target: string) => void
  markdownDocuments?: MarkdownDocument[]
  showTableOfContents?: boolean
  onCloseTableOfContents?: () => void
  markdownAnnotationsEnabled?: boolean
  markdownAnnotationFilePath?: string
  markdownSourceLineOffset?: number
  markdownReviewContent?: string
  // Show stripped front matter below the toolbar without giving it to the rich editor.
  headerSlot?: React.ReactNode
}
