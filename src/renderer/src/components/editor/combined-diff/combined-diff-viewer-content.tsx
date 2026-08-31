import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffComment } from '../../../../../shared/diff-comment-types'
import type { DiffSectionItemProps } from '../diff-section-item-props'
import type { DiffSection } from '../diff-section-types'
import {
  CombinedDiffNoChangesEmptyState,
  CombinedDiffSkippedConflictNotice,
  CombinedDiffSkippedConflictsEmptyState
} from './review-controls/combined-diff-skipped-conflicts'
import { CombinedDiffCommitHeader } from './review-controls/combined-diff-commit-header'
import { CombinedDiffToolbar } from './review-controls/combined-diff-toolbar'
import { ClearDiffNotesDialog } from './review-controls/combined-diff-notes-popover'
import type { CombinedDiffNotesActions } from './review-controls/use-combined-diff-notes-actions'
import type { CombinedDiffSectionActions } from './review-controls/use-combined-diff-section-actions'
import type { CombinedDiffViewPreferences } from './review-controls/use-combined-diff-view-preferences'
import type { CombinedDiffEntrySet } from './resolve-changes/use-combined-diff-entry-set'
import { CombinedDiffFileTree } from './browse-files/combined-diff-file-tree'
import type { CombinedDiffTreeNavigation } from './browse-files/use-combined-diff-tree-navigation'
import { CombinedDiffSectionList } from './scroll-viewport/combined-diff-section-list'
import type { CombinedDiffScrollThumb } from './scroll-viewport/use-combined-diff-scrollbar'

type SkippedConflicts = NonNullable<OpenFile['skippedConflicts']>

export function CombinedDiffViewerContent({
  activeGroupId,
  canOpenWorkspaceFileBrowserForPath,
  diffCommentsForWorktree,
  entrySet,
  file,
  handleScrollbarPointerDown,
  handleSectionSaveRef,
  isDark,
  loadSection,
  markDirectScrollInput,
  modifiedEditorsRef,
  notes,
  onOpenAlternateDiff,
  onReviewSkippedConflicts,
  openSection,
  openSectionPreview,
  preferences,
  retrySection,
  scrollThumb,
  sections,
  sectionHeights,
  setScrollContainerRef,
  setSectionHeights,
  setSections,
  settings,
  skippedConflicts,
  treeNavigation,
  toggleSection,
  virtualizer
}: {
  activeGroupId: string | undefined
  canOpenWorkspaceFileBrowserForPath: (path: string) => boolean
  diffCommentsForWorktree: DiffComment[]
  entrySet: CombinedDiffEntrySet
  file: OpenFile
  handleScrollbarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  handleSectionSaveRef: CombinedDiffSectionActions['handleSectionSaveRef']
  isDark: boolean
  loadSection: (index: number) => void
  markDirectScrollInput: () => void
  modifiedEditorsRef: DiffSectionItemProps['modifiedEditorsRef']
  notes: CombinedDiffNotesActions
  onOpenAlternateDiff: () => void
  onReviewSkippedConflicts: () => void
  openSection: (index: number) => void
  openSectionPreview: (section: DiffSection) => void
  preferences: CombinedDiffViewPreferences
  retrySection: (index: number) => void
  scrollThumb: CombinedDiffScrollThumb
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  setScrollContainerRef: (node: HTMLDivElement | null) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  settings: DiffSectionItemProps['settings']
  skippedConflicts: SkippedConflicts | undefined
  treeNavigation: CombinedDiffTreeNavigation
  toggleSection: (index: number) => void
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): React.JSX.Element {
  const commitHeader =
    entrySet.isCommitMode && entrySet.commitCompare ? (
      <CombinedDiffCommitHeader commitCompare={entrySet.commitCompare} />
    ) : null

  if (sections.length === 0 && (skippedConflicts?.length ?? 0) > 0) {
    return (
      <CombinedDiffSkippedConflictsEmptyState
        commitHeader={commitHeader}
        onReviewConflicts={onReviewSkippedConflicts}
        skippedConflicts={skippedConflicts!}
      />
    )
  }

  if (sections.length === 0) {
    return <CombinedDiffNoChangesEmptyState commitHeader={commitHeader} />
  }

  const skippedConflictNotice =
    (skippedConflicts?.length ?? 0) > 0 ? (
      <CombinedDiffSkippedConflictNotice
        onReviewConflicts={onReviewSkippedConflicts}
        skippedConflicts={skippedConflicts!}
      />
    ) : null
  const allSectionsCollapsed = sections.every((section) => section.collapsed)

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0">
        <CombinedDiffToolbar
          activeGroupId={activeGroupId}
          allSectionsCollapsed={allSectionsCollapsed}
          branchCompare={entrySet.branchCompare}
          commitCompare={entrySet.commitCompare}
          diffCommentCount={notes.diffCommentCount}
          diffCommentsForWorktree={diffCommentsForWorktree}
          diffWordWrap={settings?.diffWordWrap}
          file={file}
          fileTreeCollapsed={preferences.fileTreeCollapsed}
          isAllMode={entrySet.isAllMode}
          isBranchMode={entrySet.isBranchMode}
          isCommitMode={entrySet.isCommitMode}
          notesCopied={notes.notesCopied}
          onCopyNotes={() => void notes.handleCopyNotes()}
          onOpenAlternateDiff={onOpenAlternateDiff}
          onOpenClearNotes={() => notes.setClearNotesDialogOpen(true)}
          onShowFileTree={() => preferences.setFileTreeCollapsed(false)}
          previewDiffComments={notes.previewDiffComments}
          sectionCount={sections.length}
          setAllSectionsCollapsed={preferences.setAllSectionsCollapsed}
          sideBySide={preferences.sideBySide}
          toggleDiffWordWrap={preferences.toggleDiffWordWrap}
          toggleSideBySide={preferences.toggleSideBySide}
        />
        {commitHeader}
        <div className="flex min-h-0 flex-1">
          <CombinedDiffFileTree
            mode={entrySet.treeMode}
            worktreePath={file.filePath}
            entries={entrySet.entries}
            sectionIndexByKey={treeNavigation.sectionIndexByKey}
            activeSectionKey={treeNavigation.activeTreeSectionKey}
            viewedSectionKeys={treeNavigation.viewedSectionKeys}
            collapsed={preferences.fileTreeCollapsed}
            onCollapsedChange={preferences.setFileTreeCollapsed}
            onNavigate={treeNavigation.handleTreeNavigate}
          />
          <CombinedDiffSectionList
            activeGroupId={activeGroupId}
            canOpenWorkspaceFileBrowserForPath={canOpenWorkspaceFileBrowserForPath}
            diffCommentsForWorktree={diffCommentsForWorktree}
            file={file}
            handleSectionSaveRef={handleSectionSaveRef}
            mode={entrySet.treeMode}
            isDark={isDark}
            loadSection={loadSection}
            markDirectScrollInput={markDirectScrollInput}
            modifiedEditorsRef={modifiedEditorsRef}
            onScrollbarPointerDown={handleScrollbarPointerDown}
            openSection={openSection}
            openSectionPreview={openSectionPreview}
            retrySection={retrySection}
            scrollThumb={scrollThumb}
            sectionHeights={sectionHeights}
            sections={sections}
            setScrollContainerRef={setScrollContainerRef}
            setSectionHeights={setSectionHeights}
            setSections={setSections}
            settings={settings}
            sideBySide={preferences.sideBySide}
            skippedConflictNotice={skippedConflictNotice}
            toggleSection={toggleSection}
            virtualizer={virtualizer}
          />
        </div>
      </div>
      <ClearDiffNotesDialog
        diffCommentCount={notes.diffCommentCount}
        isClearingNotes={notes.isClearingNotes}
        onConfirm={() => void notes.handleConfirmClearNotes()}
        open={notes.clearNotesDialogVisible}
        setOpen={notes.setClearNotesDialogOpen}
      />
    </>
  )
}
