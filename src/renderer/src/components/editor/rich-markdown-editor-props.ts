import type React from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'

export type RichMarkdownEditorProps = {
  fileId: string
  viewStateId: string
  content: string
  filePath: string
  worktreeId: string
  externalSshTargetId?: string
  runtimeEnvironmentId?: string | null
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
