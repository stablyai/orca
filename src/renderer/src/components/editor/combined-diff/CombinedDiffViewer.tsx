import { useCombinedDiffExtent, useCombinedDiffViewport } from '../use-combined-diff-extent'
import { getCombinedDiffExtent } from '../combined-diff-extent-dom'
import React, { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/file-preview'
import { useVisibleWorktreeDiffComments } from '../../diff-comments/use-visible-worktree-diff-comments'
import type { OpenFile } from '@/store/slices/editor'
import '@/lib/monaco-setup'
import type { DiffSection } from '../diff-section-types'
import { useDiffSectionHeights } from '../diff-section-height-cache'
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
import { buildCombinedDiffViewTabSuccession } from './remember-view/combined-diff-view-tab-scope'
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
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'

export default function CombinedDiffViewer({
  file,
  viewStateKey,
  viewStateScopeId
}: {
  file: OpenFile
  viewStateKey: string
  viewStateScopeId?: string
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
  const { comments: diffCommentsForWorktree, markdownReviewNotesEnabled } =
    useVisibleWorktreeDiffComments(file.worktreeId)
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[file.worktreeId])
  const canOpenWorkspaceFileBrowserForPath = useWorkspaceFileBrowserActionPredicate(file.worktreeId)
  const isDark = useDocumentDarkTheme()

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights, heightAuthority] = useDiffSectionHeights(
    JSON.stringify([
      viewStateKey,
      file.worktreeId,
      file.filePath,
      file.runtimeEnvironmentId,
      file.diffSource,
      file.combinedAreaFilter,
      file.branchCompare,
      file.commitCompare
    ]),
    sections
  )
  const [generation, setGeneration] = useState(0)
  const [programmaticScrollMarks] = useState(createProgrammaticScrollMarks)
  const { scrollContainerRef, viewportNode, setViewport, beforeDetachRef, releaseViewport } =
    useCombinedDiffViewport()

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
    markdownReviewNotesEnabled,
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
    file,
    gitStatusEntries,
    registry,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide: preferences.setSideBySide,
    succession: buildCombinedDiffViewTabSuccession(file.id, viewStateScopeId),
    viewStateKey
  })
  const { loadSection, loadDeferredSection } = useCombinedDiffSectionLoader({
    entrySet,
    file,
    generation,
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

  // Share one incremental scan across virtualizer keys and toolbar collapse state.
  const sectionRowKeys = useCombinedDiffSectionRowKeys({ generation, sections })
  const sectionIndexByKey = useCombinedDiffSectionIndexMap({
    entrySignature: entrySet.entrySignature,
    sections
  })
  const markDirectScrollInput = useCallback(() => {
    const container = scrollContainerRef.current
    if (container) {
      getCombinedDiffExtent(container).input()
    }
  }, [scrollContainerRef])
  const { cleanupActiveScrollbarDrag, handleScrollbarPointerDown, scrollThumb, updateScrollbar } =
    useCombinedDiffScrollbar({ markDirectScrollInput, scrollContainerRef })
  const virtualizer = useCombinedDiffVirtualizer({
    generation,
    renderedIndicesRef: registry.renderedIndicesRef,
    rowKeys: sectionRowKeys.rowKeys,
    scrollContainerRef,
    scrollOffsetRef: restore.scrollOffsetRef,
    sectionHeights,
    heightAuthority,
    sections,
    sideBySide: preferences.sideBySide
  })
  const anchors = useCombinedDiffScrollAnchors({
    restorationKey: restore.restorationKey,
    scrollAnchorRef: restore.scrollAnchorRef,
    viewportNode,
    beforeDetachRef,
    releaseViewport,
    scrollOffsetRef: restore.scrollOffsetRef,
    memoryLeaseRef: restore.memoryLeaseRef,
    virtualizer
  })

  useCombinedDiffExtent(
    viewportNode,
    virtualizer,
    programmaticScrollMarks.mark,
    sections,
    restore.restorationKey
  )

  const toggleSection = useCallback(
    (index: number) => {
      const section = registry.sectionsRef.current[index]
      const shouldLoadAfterExpand = section?.collapsed ?? false
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
    memoryLeaseRef: restore.memoryLeaseRef,
    scrollContainerRef,
    sectionHeights,
    sections,
    sideBySide: preferences.sideBySide,
    viewStateKey
  })
  useCombinedDiffScrollPersistence({ viewportNode, updateScrollbar })

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
      setViewport(node)
      setScrollSurfaceMounted(node !== null)
      if (node === null) {
        cleanupActiveScrollbarDrag()
        return
      }
      window.requestAnimationFrame(updateScrollbar)
    },
    [cleanupActiveScrollbarDrag, setScrollSurfaceMounted, setViewport, updateScrollbar]
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
            sourceWorkspaceId={file.worktreeId}
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
