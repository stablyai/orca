import type React from 'react'
import { useMemo } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { DiffSectionItem } from '../../DiffSectionItem'
import type { DiffSectionItemProps } from '../../diff-section-item-props'
import { DiffNotesSendMenu } from '../../DiffNotesSendMenu'
import { canOpenDiffSectionPreviewToSide } from '../../diff-section-preview'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffScrollThumb } from './use-combined-diff-scrollbar'

export function CombinedDiffSectionList({
  activeGroupId,
  canOpenWorkspaceFileBrowserForPath,
  diffCommentsForWorktree,
  file,
  handleSectionSaveRef,
  isAllMode,
  isBranchMode,
  isCommitMode,
  isDark,
  loadSection,
  loadDeferredSection,
  markDirectScrollInput,
  modifiedEditorsRef,
  onScrollbarPointerDown,
  openSection,
  openSectionPreview,
  retrySection,
  scrollThumb,
  sectionHeights,
  sections,
  setScrollContainerRef,
  setSectionHeights,
  setSections,
  settings,
  sideBySide,
  skippedConflictNotice,
  toggleSection,
  virtualizer
}: {
  activeGroupId: string | undefined
  canOpenWorkspaceFileBrowserForPath: (path: string) => boolean
  diffCommentsForWorktree: DiffComment[]
  file: OpenFile
  handleSectionSaveRef: DiffSectionItemProps['handleSectionSaveRef']
  isAllMode: boolean
  isBranchMode: boolean
  isCommitMode: boolean
  isDark: boolean
  loadSection: (index: number) => void
  loadDeferredSection: (index: number) => void
  markDirectScrollInput: () => void
  modifiedEditorsRef: DiffSectionItemProps['modifiedEditorsRef']
  onScrollbarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
  retrySection: (index: number) => void
  scrollThumb: CombinedDiffScrollThumb
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  setScrollContainerRef: (node: HTMLDivElement | null) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  settings: DiffSectionItemProps['settings']
  sideBySide: boolean
  skippedConflictNotice: React.ReactNode
  toggleSection: (index: number) => void
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): React.JSX.Element {
  // Why: per-row filter() rescanned all worktree comments per visible row per render — index once, same order preserved.
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
                data-combined-diff-section-row
                data-combined-diff-section-key={section.key}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                // Why: position via top, not transform, so sticky file headers don't jump (transform creates a containing block).
                style={{ top: `${virtualItem.start}px` }}
              >
                <DiffSectionItem
                  section={section}
                  index={virtualItem.index}
                  isBranchMode={isBranchMode}
                  sideBySide={sideBySide}
                  isDark={isDark}
                  settings={settings}
                  sectionHeight={sectionHeights[virtualItem.index]}
                  worktreeId={file.worktreeId}
                  loadSection={loadSection}
                  loadDeferredSection={loadDeferredSection}
                  retrySection={retrySection}
                  toggleSection={toggleSection}
                  openSection={openSection}
                  openSectionTitle={
                    isAllMode || isBranchMode || isCommitMode ? 'Open diff' : 'Open in editor'
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
