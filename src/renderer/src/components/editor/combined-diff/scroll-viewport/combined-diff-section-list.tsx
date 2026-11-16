import { combinedDiffViewportAttributes, combinedDiffRowAttributes } from './combined-diff-viewport'
import type React from 'react'
import { useMemo } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { DiffComment } from '../../../../../../shared/file-review/diff-comment-types'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import { DiffSectionItem } from '../../diff/sections/DiffSectionItem'
import type { DiffSectionItemProps } from '../../diff/sections/diff-section-item-props'
import { DiffNotesSendMenu } from '../../diff/review/DiffNotesSendMenu'
import { canOpenDiffSectionPreviewToSide } from '../../diff/sections/diff-section-preview'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import type { CombinedDiffScrollThumb } from './use-combined-diff-scrollbar'
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
  loadSection,
  loadDeferredSection,
  markDirectScrollInput,
  onScrollbarPointerDown,
  openSection,
  openSectionPreview,
  retrySection,
  scrollThumb,
  sectionHeights,
  sections,
  viewStateKey,
  setScrollContainerRef,
  setSectionHeights,
  setSections,
  sideBySide,
  skippedConflictNotice,
  toggleSection,
  virtualizer
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
  loadSection: (index: number) => void
  loadDeferredSection: (index: number) => void
  markDirectScrollInput: () => void
  onScrollbarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
  retrySection: (index: number) => void
  scrollThumb: CombinedDiffScrollThumb
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  viewStateKey: string
  setScrollContainerRef: (node: HTMLDivElement | null) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  sideBySide: boolean
  skippedConflictNotice: React.ReactNode
  toggleSection: (index: number) => void
  virtualizer: Virtualizer<HTMLDivElement, Element>
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
      <div
        {...combinedDiffViewportAttributes}
        ref={setScrollContainerRef}
        className="combined-diff-scroll-container h-full overflow-auto pr-5 scrollbar-editor"
        onWheel={markDirectScrollInput}
        onTouchMove={markDirectScrollInput}
      >
        {skippedConflictNotice}
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const section = sections[virtualItem.index]
            if (!section) {
              return null
            }

            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                {...combinedDiffRowAttributes}
                data-combined-diff-section-key={section.key}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                // Position with top: transforms create containing blocks that make sticky headers jump.
                style={{ top: `${virtualItem.start}px` }}
              >
                <DiffSectionItem
                  section={section}
                  index={virtualItem.index}
                  // Scope excludes contentGeneration: a revalidation that lands after a save
                  // would otherwise orphan the stored selection and undo history. Staleness is
                  // already handled by the content check in createPierreEditor.
                  editStateKey={`${viewStateKey}:${section.key}`}
                  renderKey={`${viewStateKey}:${section.key}:${section.contentGeneration ?? 0}`}
                  isBranchMode={isBranchMode}
                  sideBySide={sideBySide}
                  sectionHeight={sectionHeights[virtualItem.index]}
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
                      : t(
                          'auto.components.editor.CombinedDiffViewer.openInEditor',
                          'Open in editor'
                        )
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
              </div>
            )
          })}
        </div>
      </div>
      {scrollThumb.visible && (
        <div
          aria-hidden="true"
          className="absolute inset-y-1 right-1 z-20 w-4 cursor-default rounded bg-muted/15 pl-1"
          onPointerDown={onScrollbarPointerDown}
        >
          <div
            data-combined-diff-scrollbar-thumb
            className="absolute left-1 right-0 rounded bg-muted-foreground/30"
            style={{ top: scrollThumb.top, height: scrollThumb.height }}
          />
        </div>
      )}
    </div>
  )
}
