import type { WorkspaceResource } from '@/lib/workspace/ownership/workspace-copy-owner'
import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react'
import type { DecoratedDiffComment } from '@/components/diff-comments/decorated-diff-comment'
import type { DiffSection } from './diff-section-types'

export type DiffSectionItemProps = {
  section: DiffSection
  index: number
  editStateKey?: string
  /** Remount identity; changes when refetched content replaces the section. */
  renderKey?: string
  isBranchMode: boolean
  sideBySide: boolean
  sectionHeight: number | undefined
  worktreeId?: string
  noteSource?: WorkspaceResource
  imageUploadAddress?: GitHubImageIntake['address']
  loadSection: (index: number) => void
  loadDeferredSection?: (index: number) => void
  retrySection: (index: number) => void
  toggleSection: (index: number) => void
  openSection: (index: number) => void
  openSectionTitle: string
  onOpenPreview?: (section: DiffSection, index: number) => void
  renderHeaderTrailingContent?: (section: DiffSection, index: number) => ReactNode
  onAddLineComment?: (
    section: DiffSection,
    args: { lineNumber: number; startLine?: number; body: string }
  ) => Promise<boolean>
  addLineCommentLabel?: string
  addLineCommentPlaceholder?: string
  inlineComments?: readonly DecoratedDiffComment[]
  getCommentableLineNumbers?: (section: DiffSection) => readonly number[] | undefined
  setSectionHeights: Dispatch<SetStateAction<Record<number, number>>>
  setSections: Dispatch<SetStateAction<DiffSection[]>>
  /** `overwrite` comes only from the section's conflict bar. */
  handleSectionSaveRef: MutableRefObject<(index: number, mode?: 'overwrite') => Promise<void>>
}
