import type React from 'react'
import { useMemo } from 'react'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { DiffSectionItem } from '../../diff/sections/DiffSectionItem'
import type { DiffSectionItemProps } from '../../diff/sections/diff-section-item-props'
import { DiffNotesSendMenu } from '../../diff/review/DiffNotesSendMenu'
import { canOpenDiffSectionPreviewToSide } from '../../diff/sections/diff-section-preview'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { CombinedDiffViewport } from './CombinedDiffViewport'
import type { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'
import { useTranslate } from '@/i18n/use-translate'

export function CombinedDiffSectionList({
  activeGroupId,
  canOpenWorkspaceFileBrowserForPath,
  commentOwner,
  diffCommentsForWorktree,
  file,
  handleSectionSaveRef,
  isAllMode,
  isBranchMode,
  isCommitMode,
  isDark,
  loadSection,
  loadDeferredSection,
  modifiedEditorsRef,
  openSection,
  openSectionPreview,
  retrySection,
  setScrollContainerRef,
  sectionHeights,
  sections,
  setSectionHeights,
  setSections,
  sideBySide,
  skippedConflictNotice,
  toggleSection,
  viewport
}: {
  activeGroupId: string | undefined
  canOpenWorkspaceFileBrowserForPath: (path: string) => boolean
  commentOwner: DiffCommentOwner | null
  diffCommentsForWorktree: DiffComment[]
  file: OpenFile
  handleSectionSaveRef: DiffSectionItemProps['handleSectionSaveRef']
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  isDark: boolean
  loadSection: (index: number) => void
  loadDeferredSection: (index: number) => void
  modifiedEditorsRef: DiffSectionItemProps['modifiedEditorsRef']
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
  retrySection: (index: number) => void
  setScrollContainerRef: (node: HTMLDivElement | null) => void
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  sideBySide: boolean
  skippedConflictNotice: React.ReactNode
  toggleSection: (index: number) => void
  viewport: CombinedDiffViewportOwner
}): React.JSX.Element {
  const t = useTranslate()
  // Index comments once by file instead of rescanning all worktree comments per visible row.
  const commentCountByFilePath = useMemo(() => {
    const counts = new Map<string, number>()
    for (const comment of diffCommentsForWorktree) {
      counts.set(comment.filePath, (counts.get(comment.filePath) ?? 0) + 1)
    }
    return counts
  }, [diffCommentsForWorktree])
  return (
    <div className="relative min-w-0 flex-1">
      <CombinedDiffViewport owner={viewport} onMount={setScrollContainerRef}>
        {(index) => {
          if (index < 0) {
            return <div>{skippedConflictNotice}</div>
          }
          const section = sections[index]
          if (!section) {
            return null
          }
          return (
            <DiffSectionItem
              section={section}
              index={index}
              isBranchMode={isBranchMode}
              sideBySide={sideBySide}
              isDark={isDark}
              sectionHeight={sectionHeights[index]}
              worktreeId={file.worktreeId}
              noteSource={file}
              loadSection={loadSection}
              loadDeferredSection={loadDeferredSection}
              retrySection={retrySection}
              toggleSection={toggleSection}
              openSection={openSection}
              openSectionTitle={
                isAllMode || isBranchMode || isCommitMode
                  ? t('auto.components.editor.CombinedDiffViewer.openDiff', 'Open diff')
                  : t('auto.components.editor.CombinedDiffViewer.openInEditor', 'Open in editor')
              }
              onOpenPreview={
                canOpenDiffSectionPreviewToSide({
                  path: section.path,
                  status: section.status,
                  isCommitSurface: isCommitMode,
                  canOpenWorkspaceFileBrowser: canOpenWorkspaceFileBrowserForPath(
                    joinPath(file.filePath, section.path)
                  )
                })
                  ? openSectionPreview
                  : undefined
              }
              setSectionHeights={setSectionHeights}
              setSections={setSections}
              modifiedEditorsRef={modifiedEditorsRef}
              handleSectionSaveRef={handleSectionSaveRef}
              renderHeaderTrailingContent={(section) => {
                const fileNoteCount = commentCountByFilePath.get(section.path) ?? 0
                return fileNoteCount > 0 ? (
                  <DiffNotesSendMenu
                    owner={commentOwner}
                    worktreeId={file.worktreeId}
                    groupId={activeGroupId ?? file.worktreeId}
                    comments={diffCommentsForWorktree}
                    filePath={section.path}
                    showFileScope
                    triggerClassName="p-0.5 can-hover:opacity-0 group-hover:opacity-100"
                  />
                ) : null
              }}
            />
          )
        }}
      </CombinedDiffViewport>
    </div>
  )
}
