import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store'
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
import { CombinedDiffViewerContent } from './combined-diff-viewer-content'
import { useCombinedDiffTreeNavigation } from './browse-files/use-combined-diff-tree-navigation'
import { useCombinedDiffNotesActions } from './review-controls/use-combined-diff-notes-actions'
import { useCombinedDiffSectionActions } from './review-controls/use-combined-diff-section-actions'
import { useCombinedDiffViewPreferences } from './review-controls/use-combined-diff-view-preferences'

function openCombinedDiffAlternate({
  branchSummary,
  file,
  openAllDiffs,
  openBranchAllDiffs
}: {
  branchSummary: AppState['gitBranchCompareSummaryByWorktree'][string]
  file: OpenFile
  openAllDiffs: AppState['openAllDiffs']
  openBranchAllDiffs: AppState['openBranchAllDiffs']
}): void {
  if (!file.combinedAlternate) {
    return
  }
  if (file.combinedAlternate.source === 'combined-all') {
    openAllDiffs(file.worktreeId, file.filePath)
    return
  }
  if (branchSummary?.status === 'ready') {
    openBranchAllDiffs(file.worktreeId, file.filePath, branchSummary, {
      source: 'combined-all'
    })
  }
}

function reviewCombinedDiffSkippedConflicts({
  file,
  openConflictReview,
  skippedConflicts
}: {
  file: OpenFile
  openConflictReview: AppState['openConflictReview']
  skippedConflicts: OpenFile['skippedConflicts']
}): void {
  openConflictReview(
    file.worktreeId,
    file.filePath,
    (skippedConflicts ?? []).map((entry) => ({
      path: entry.path,
      conflictKind: entry.conflictKind
    })),
    'combined-diff-exclusion'
  )
}

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
  const loadSection = useCombinedDiffSectionLoader({
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

  const { hasDirectScrollInput, markDirectScrollInput } = useCombinedDiffDirectScrollInput()
  const { cleanupActiveScrollbarDrag, handleScrollbarPointerDown, scrollThumb, updateScrollbar } =
    useCombinedDiffScrollbar({ markDirectScrollInput, scrollContainerRef })
  const virtualizer = useCombinedDiffVirtualizer({
    generation,
    programmaticScrollMarks,
    renderedIndicesRef: registry.renderedIndicesRef,
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
    sections,
    sectionsRef: registry.sectionsRef,
    sideBySide: preferences.sideBySide,
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
    sections,
    sectionsRef: registry.sectionsRef,
    toggleSection,
    treeMode: entrySet.treeMode
  })
  const combinedGitStatusSignature = useCombinedDiffSectionRevalidation({
    file,
    gitStatusEntries,
    requestSectionReload,
    sectionIndexByKeyRef: treeNavigation.sectionIndexByKeyRef,
    sections,
    shouldAutoReloadFromGitStatus: entrySet.shouldAutoReloadFromGitStatus,
    treeMode: entrySet.treeMode
  })
  const previousCombinedGitStatusSignatureRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entrySet.shouldAutoReloadFromGitStatus) {
      previousCombinedGitStatusSignatureRef.current = null
      return
    }
    if (previousCombinedGitStatusSignatureRef.current === null) {
      previousCombinedGitStatusSignatureRef.current = combinedGitStatusSignature
      return
    }
    if (previousCombinedGitStatusSignatureRef.current === combinedGitStatusSignature) {
      return
    }
    previousCombinedGitStatusSignatureRef.current = combinedGitStatusSignature
    for (const index of registry.loadedIndicesRef.current) {
      requestSectionReload(index)
    }
  }, [
    combinedGitStatusSignature,
    entrySet.shouldAutoReloadFromGitStatus,
    registry.loadedIndicesRef,
    requestSectionReload
  ])
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
    sectionHeights,
    sections,
    setClampRestoreCount,
    updateScrollbar,
    viewStateKey
  })

  const openAlternateDiff = useCallback(
    () => openCombinedDiffAlternate({ branchSummary, file, openAllDiffs, openBranchAllDiffs }),
    [branchSummary, file, openAllDiffs, openBranchAllDiffs]
  )

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
  const reviewSkippedConflicts = useCallback(
    () => reviewCombinedDiffSkippedConflicts({ file, openConflictReview, skippedConflicts }),
    [file, openConflictReview, skippedConflicts]
  )

  return (
    <CombinedDiffViewerContent
      activeGroupId={activeGroupId}
      canOpenWorkspaceFileBrowserForPath={canOpenWorkspaceFileBrowserForPath}
      diffCommentsForWorktree={diffCommentsForWorktree}
      entrySet={entrySet}
      file={file}
      handleScrollbarPointerDown={handleScrollbarPointerDown}
      handleSectionSaveRef={handleSectionSaveRef}
      isDark={isDark}
      loadSection={loadSection}
      markDirectScrollInput={markDirectScrollInput}
      modifiedEditorsRef={modifiedEditorsRef}
      notes={notes}
      onOpenAlternateDiff={openAlternateDiff}
      onReviewSkippedConflicts={reviewSkippedConflicts}
      openSection={openSection}
      openSectionPreview={openSectionPreview}
      preferences={preferences}
      retrySection={retrySection}
      scrollThumb={scrollThumb}
      sections={sections}
      sectionHeights={sectionHeights}
      setScrollContainerRef={setScrollContainerRef}
      setSectionHeights={setSectionHeights}
      setSections={setSections}
      settings={settings}
      skippedConflicts={skippedConflicts}
      toggleSection={toggleSection}
      treeNavigation={treeNavigation}
      virtualizer={virtualizer}
    />
  )
}
