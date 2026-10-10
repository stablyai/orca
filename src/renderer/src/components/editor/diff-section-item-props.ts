import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import type { DecoratedDiffComment } from '../diff-comments/decorated-diff-comment'
import type { DiffSection } from './diff-section-types'

export type DiffSectionItemProps = {
  section: DiffSection
  index: number
  isBranchMode: boolean
  sideBySide: boolean
  isDark: boolean
  settings: {
    terminalFontSize?: number
    terminalFontFamily?: string
    diffWordWrap?: boolean
    diffShowWhitespace?: boolean
  } | null
  sectionHeight: number | undefined
  worktreeId?: string
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
  modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>
}
