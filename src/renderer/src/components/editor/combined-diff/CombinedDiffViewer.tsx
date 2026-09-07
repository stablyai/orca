import React, { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import { selectWorktreeDiffCommentsOrEmpty } from '@/store/worktree-diff-comments-selector'
import type { OpenFile } from '@/store/slices/editor'
import '@/lib/monaco-setup'
import type { DiffSection } from '../diff-section-types'
import {
  EMPTY_GIT_BRANCH_ENTRIES,
  EMPTY_GIT_STATUS_ENTRIES,
  useCombinedDiffEntrySet
} from './resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionIndexMap } from './resolve-changes/use-combined-diff-section-index-map'
import { useCombinedDiffSectionRowKeys } from './resolve-changes/use-combined-diff-section-row-keys'
import { useCombinedDiffSectionLoadRegistry } from './load-sections/combined-diff-section-load-registry'
import { useCombinedDiffSectionLoader } from './load-sections/use-combined-diff-section-loader'
import { useCombinedDiffSectionRetry } from './load-sections/use-combined-diff-section-retry'
import { useCombinedDiffSectionRevalidation } from './load-sections/use-combined-diff-section-revalidation'
import { useCombinedDiffViewPersist } from './remember-view/use-combined-diff-view-persist'
import { useCombinedDiffViewRestore } from './remember-view/use-combined-diff-view-restore'
import { useCombinedDiffDirectScrollInput } from './scroll-viewport/use-combined-diff-direct-scroll-input'
import { useCombinedDiffScrollAnchors } from './scroll-viewport/use-combined-diff-scroll-anchors'
import { useCombinedDiffScrollPersistence } from './scroll-viewport/use-combined-diff-scroll-persistence'
import { useCombinedDiffScrollbar } from './scroll-viewport/use-combined-diff-scrollbar'
import { useCombinedDiffVirtualizer } from './scroll-viewport/use-combined-diff-virtualizer'
import { CombinedDiffSectionList } from './scroll-viewport/combined-diff-section-list'
import { CombinedDiffFileTree } from './browse-files/combined-diff-file-tree'
import { useCombinedDiffTreeNavigation } from './browse-files/use-combined-diff-tree-navigation'
import { CombinedDiffCommitHeader } from './review-controls/combined-diff-commit-header'
import { CombinedDiffToolbar } from './review-controls/combined-diff-toolbar'
import { ClearDiffNotesDialog } from './review-controls/combined-diff-notes-popover'
import {
  CombinedDiffNoChangesEmptyState,
  CombinedDiffSkippedConflictNotice,
  CombinedDiffSkippedConflictsEmptyState
} from './review-controls/combined-diff-skipped-conflicts'
import { useCombinedDiffNotesActions } from './review-controls/use-combined-diff-notes-actions'
import { useCombinedDiffSectionActions } from './review-controls/use-combined-diff-section-actions'
import { useCombinedDiffViewPreferences } from './review-controls/use-combined-diff-view-preferences'

export default function CombinedDiffViewer({
  file,
  viewStateKey
}: {
  file: OpenFile
  viewStateKey: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const gitStatusEntries = useAppStore(
    (s) => s.gitStatusByWorktree[file.worktreeId] ?? EMPTY_GIT_STATUS_ENTRIES
  )
  const liveBranchEntries = useAppStore(
    (s) => s.gitBranchChangesByWorktree[file.worktreeId] ?? EMPTY_GIT_BRANCH_ENTRIES
  )
  const branchSummary = useAppStore((s) => s.gitBranchCompareSummaryByWorktree[file.worktreeId])
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  const diffCommentsForWorktree = useAppStore((s) =>
    selectWorktreeDiffCommentsOrEmpty(s, file.worktreeId)
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[file.worktreeId])
  const canOpenWorkspaceFileBrowserForPath = useWorkspaceFileBrowserActionPredicate(file.worktreeId)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [generation, setGeneration] = useState(0)
  // Why: a browser scroll clamp must re-pin the restore without being recorded as user intent.
  const [clampRestoreCount, setClampRestoreCount] = useState(0)
  const [programmaticScrollMarks] = useState(createProgrammaticScrollMarks)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const entrySet = useCombinedDiffEntrySet({
    file,
    gitStatusEntries,
    liveBranchEntries,
    sectionsRef: registry.sectionsRef
  })
  const notes = useCombinedDiffNotesActions({
    clearDiffComments,
    diffCommentsForWorktree,
    worktreeId: file.worktreeId
  })
  const preferences = useCombinedDiffViewPreferences({
    combinedDiffFileTreeVisibleByDefault: settings?.combinedDiffFileTreeVisibleByDefault,
    diffDefaultView: settings?.diffDefaultView,
    diffShowWhitespace: settings?.diffShowWhitespace,
    diffWordWrap: settings?.diffWordWrap,
    registry,
    setSections,
    updateSettings
  })
  const restore = useCombinedDiffViewRestore({
    entrySet,
    gitStatusEntries,
    registry,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide: preferences.setSideBySide,
    viewStateKey
  })
  const { loadSection, loadDeferredSection } = useCombinedDiffSectionLoader({
    entrySet,
    file,
    registry,
    sectionCount: sections.length,
    setSectionHeights,
    setSections
  })
  const { ensureSectionLoaded, requestSectionReload, retrySection } = useCombinedDiffSectionRetry({
    invalidateViewStateCache: restore.invalidateViewStateCache,
    registry,
    setSectionHeights,
    setSections
  })

  // Why: one incremental scan of `sections` feeds the virtualizer keys, the restore signal and the
  // toolbar collapse state, instead of three independent full passes per loaded section.
  const sectionRowKeys = useCombinedDiffSectionRowKeys({ generation, sections })
  const sectionIndexByKey = useCombinedDiffSectionIndexMap({
    entrySignature: entrySet.entrySignature,
    sections
  })
  const { hasDirectScrollInput, markDirectScrollInput } = useCombinedDiffDirectScrollInput()
  const { cleanupActiveScrollbarDrag, handleScrollbarPointerDown, scrollThumb, updateScrollbar } =
    useCombinedDiffScrollbar({ markDirectScrollInput, scrollContainerRef })
  const virtualizer = useCombinedDiffVirtualizer({
    generation,
    programmaticScrollMarks,
    renderedIndicesRef: registry.renderedIndicesRef,
    rowKeys: sectionRowKeys.rowKeys,
    scrollContainerRef,
    scrollOffsetRef: restore.scrollOffsetRef,
    sectionHeights,
    sections,
    sideBySide: preferences.sideBySide
  })
  const anchors = useCombinedDiffScrollAnchors({
    clampRestoreCount,
    generation,
    hasDirectScrollInput,
    latestDomScrollAnchorRef: restore.latestDomScrollAnchorRef,
    programmaticScrollMarks,
    scrollAnchorRef: restore.scrollAnchorRef,
    scrollContainerRef,
    scrollOffsetRef: restore.scrollOffsetRef,
    sectionIndexByKey,
    sections,
    sectionsRef: registry.sectionsRef,
    sideBySide: preferences.sideBySide,
    structureRevision: sectionRowKeys.structureRevision,
    totalSize: virtualizer.getTotalSize(),
    viewStateKey,
    virtualizer
  })

  const toggleSection = useCallback(
    (index: number) => {
      const shouldLoadAfterExpand = registry.sectionsRef.current[index]?.collapsed ?? false
      setSections((prev) =>
        prev.map((s, i) => (i === index ? { ...s, collapsed: !s.collapsed } : s))
      )
      if (shouldLoadAfterExpand) {
        registry.loadSchedulerRef.current.request(index)
      }
    },
    [registry.loadSchedulerRef, registry.sectionsRef]
  )

  const treeNavigation = useCombinedDiffTreeNavigation({
    ensureSectionLoaded,
    entrySignature: entrySet.entrySignature,
    markDirectScrollInput,
    scrollToIndex: anchors.scrollToSectionIndex,
    sectionIndexByKey,
    sections,
    sectionsRef: registry.sectionsRef,
    toggleSection,
    treeMode: entrySet.treeMode
  })
  const combinedGitStatusSignature = useCombinedDiffSectionRevalidation({
    file,
    gitStatusEntries,
    registry,
    requestSectionReload,
    sectionIndexByKeyRef: treeNavigation.sectionIndexByKeyRef,
    sectionEntries: entrySet.entries,
    shouldAutoReloadFromGitStatus: entrySet.shouldAutoReloadFromGitStatus,
    treeMode: entrySet.treeMode
  })
  const { handleSectionSaveRef, modifiedEditorsRef, openSection, openSectionPreview } =
    useCombinedDiffSectionActions({
      activeGroupId,
      branchCompare: entrySet.branchCompare,
      canOpenWorkspaceFileBrowserForPath,
      commitCompare: entrySet.commitCompare,
      file,
      isAllMode: entrySet.isAllMode,
      isBranchMode: entrySet.isBranchMode,
      isCommitMode: entrySet.isCommitMode,
      sections,
      sectionsRef: registry.sectionsRef,
      setSectionHeights,
      setSections
    })

  useCombinedDiffViewPersist({
    combinedGitStatusSignature,
    entryCount: entrySet.entries.length,
    entrySignature: entrySet.entrySignature,
    loadedIndicesRef: registry.loadedIndicesRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    sideBySide: preferences.sideBySide,
    viewStateKey
  })
  useCombinedDiffScrollPersistence({
    anchors,
    entrySignature: entrySet.entrySignature,
    hasDirectScrollInput,
    latestDomScrollAnchorRef: restore.latestDomScrollAnchorRef,
    programmaticScrollMarks,
    scrollAnchorRef: restore.scrollAnchorRef,
    scrollContainerRef,
    scrollOffsetRef: restore.scrollOffsetRef,
    sectionCount: sections.length,
    sectionHeights,
    sections,
    setClampRestoreCount,
    updateScrollbar,
    viewStateKey
  })

  const openAlternateDiff = useCallback(() => {
    if (!file.combinedAlternate) {
      return
    }

    if (file.combinedAlternate.source === 'combined-all') {
      openAllDiffs(file.worktreeId, file.filePath)
      return
    }

    if (branchSummary && branchSummary.status === 'ready') {
      openBranchAllDiffs(file.worktreeId, file.filePath, branchSummary, {
        source: 'combined-all'
      })
    }
  }, [branchSummary, file, openAllDiffs, openBranchAllDiffs])

  const { setScrollSurfaceMounted } = notes
  const setScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node
      setScrollSurfaceMounted(node !== null)
      if (node === null) {
        cleanupActiveScrollbarDrag()
        return
      }
      window.requestAnimationFrame(updateScrollbar)
    },
    [cleanupActiveScrollbarDrag, setScrollSurfaceMounted, updateScrollbar]
  )

  const skippedConflicts = file.skippedConflicts
  const reviewSkippedConflicts = useCallback(() => {
    openConflictReview(
      file.worktreeId,
      file.filePath,
      (skippedConflicts ?? []).map((entry) => ({
        path: entry.path,
        conflictKind: entry.conflictKind
      })),
      'combined-diff-exclusion'
    )
  }, [file.filePath, file.worktreeId, openConflictReview, skippedConflicts])

  const commitHeader =
    entrySet.isCommitMode && entrySet.commitCompare ? (
      <CombinedDiffCommitHeader commitCompare={entrySet.commitCompare} />
    ) : null

  if (sections.length === 0 && (skippedConflicts?.length ?? 0) > 0) {
    return (
      <CombinedDiffSkippedConflictsEmptyState
        commitHeader={commitHeader}
        onReviewConflicts={reviewSkippedConflicts}
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
        onReviewConflicts={reviewSkippedConflicts}
        skippedConflicts={skippedConflicts!}
      />
    ) : null
  const allSectionsCollapsed = sectionRowKeys.allSectionsCollapsed

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
          diffShowWhitespace={settings?.diffShowWhitespace}
          diffWordWrap={settings?.diffWordWrap}
          file={file}
          fileTreeCollapsed={preferences.fileTreeCollapsed}
          isAllMode={entrySet.isAllMode}
          isBranchMode={entrySet.isBranchMode}
          isCommitMode={entrySet.isCommitMode}
          notesCopied={notes.notesCopied}
          onCopyNotes={() => void notes.handleCopyNotes()}
          onOpenAlternateDiff={openAlternateDiff}
          onOpenClearNotes={() => notes.setClearNotesDialogOpen(true)}
          onShowFileTree={() => preferences.setFileTreeCollapsed(false)}
          previewDiffComments={notes.previewDiffComments}
          sectionCount={sections.length}
          setAllSectionsCollapsed={preferences.setAllSectionsCollapsed}
          sideBySide={preferences.sideBySide}
          toggleDiffShowWhitespace={preferences.toggleDiffShowWhitespace}
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
            isAllMode={entrySet.isAllMode}
            isBranchMode={entrySet.isBranchMode}
            isCommitMode={entrySet.isCommitMode}
            isDark={isDark}
            loadSection={loadSection}
            loadDeferredSection={loadDeferredSection}
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
