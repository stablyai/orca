import { DiffCommentSessionScope } from '../../diff-comments/diff-comment-session-registry'
import { useDiffCommentView } from '../../diff-comments/use-diff-comment-owner'
import { diffCommentOwnerKey } from '@/store/slices/diff-comments/diff-comment-owner'
import { editorViewPlacement } from '@/store/slices/editor/tabs/editor-view-placement'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useWorkspaceFileBrowserActionPredicate } from '@/lib/browser/documents/file-preview'
import { useVisibleWorktreeDiffComments } from '../../diff-comments/use-visible-worktree-diff-comments'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import '@/lib/editor/monaco/monaco-setup'
import type { DiffSection } from '../diff/sections/diff-section-types'
import {
  EMPTY_GIT_BRANCH_ENTRIES,
  EMPTY_GIT_STATUS_ENTRIES,
  useCombinedDiffEntrySet
} from './resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffSectionIndexMap } from './resolve-changes/use-combined-diff-section-index-map'
import { useCombinedDiffSectionLoadRegistry } from './load-sections/combined-diff-section-load-registry'
import { useCombinedDiffSectionLoader } from './load-sections/use-combined-diff-section-loader'
import { useCombinedDiffSectionRetry } from './load-sections/use-combined-diff-section-retry'
import { useCombinedDiffSectionRevalidation } from './load-sections/use-combined-diff-section-revalidation'
import { useCombinedDiffViewPersist } from './remember-view/use-combined-diff-view-persist'
import { useCombinedDiffViewRestore } from './remember-view/use-combined-diff-view-restore'
import { buildCombinedDiffViewTabSuccession } from './remember-view/combined-diff-view-tab-scope'
import { useCombinedDiffViewport } from './scroll-viewport/CombinedDiffViewport'
import { useCombinedDiffOwnerMemory } from './remember-view/use-combined-diff-owner-memory'
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

type CombinedDiffViewerProps = {
  file: OpenFile
  viewStateKey: string
  viewStateScopeId?: string
}

export default function CombinedDiffViewer(props: CombinedDiffViewerProps): React.JSX.Element {
  const { owner, comments } = useDiffCommentView(props.file.worktreeId, props.file)
  const previousScope = useRef('unresolved')
  const scope = owner ? diffCommentOwnerKey(owner) : previousScope.current
  if (owner) {
    previousScope.current = scope
  }
  const knownNoteIds = useMemo(
    () => (comments ? new Set(comments.map((note) => note.id)) : undefined),
    [comments]
  )
  return (
    <DiffCommentSessionScope scope={scope} knownNoteIds={knownNoteIds}>
      <CombinedDiffViewerBody {...props} />
    </DiffCommentSessionScope>
  )
}

function CombinedDiffViewerBody({
  file,
  viewStateKey,
  viewStateScopeId
}: CombinedDiffViewerProps): React.JSX.Element {
  const combinedDiffFileTreeVisibleByDefault = useAppStore(
    (s) => s.settings?.combinedDiffFileTreeVisibleByDefault
  )
  const diffDefaultView = useAppStore((s) => s.settings?.diffDefaultView)
  const diffShowWhitespace = useAppStore((s) => s.settings?.diffShowWhitespace)
  const diffWordWrap = useAppStore((s) => s.settings?.diffWordWrap)
  const gitStatusEntries = useAppStore(
    (s) => s.gitStatusByWorktree[file.worktreeId] ?? EMPTY_GIT_STATUS_ENTRIES
  )
  const liveBranchEntries = useAppStore(
    (s) => s.gitBranchChangesByWorktree[file.worktreeId] ?? EMPTY_GIT_BRANCH_ENTRIES
  )
  const branchSummary = useAppStore((s) => s.gitBranchCompareSummaryByWorktree[file.worktreeId])
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  // The notes of the copy this diff was read from (the file's server when it names one).
  const notesView = useVisibleWorktreeDiffComments(file.worktreeId, file)
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[file.worktreeId])
  const canOpenWorkspaceFileBrowserForPath = useWorkspaceFileBrowserActionPredicate(file.worktreeId)
  const isDark = useDocumentDarkTheme()

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [generation, setGeneration] = useState(0)

  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const entrySet = useCombinedDiffEntrySet({
    file,
    gitStatusEntries,
    liveBranchEntries,
    sectionsRef: registry.sectionsRef
  })
  const notes = useCombinedDiffNotesActions({
    owner: notesView.owner,
    clearDiffComments,
    diffCommentsForWorktree: notesView.comments,
    markdownReviewNotesEnabled: notesView.markdownReviewNotesEnabled
  })
  const preferences = useCombinedDiffViewPreferences({
    combinedDiffFileTreeVisibleByDefault,
    diffDefaultView,
    diffShowWhitespace,
    diffWordWrap,
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

  const sectionIndexByKey = useCombinedDiffSectionIndexMap({
    entrySignature: entrySet.entrySignature,
    sections
  })
  const viewport = useCombinedDiffViewport({
    sections,
    sectionHeights,
    prefix: (file.skippedConflicts?.length ?? 0) > 0,
    expectedCount: entrySet.entries.length,
    renderedIndicesRef: registry.renderedIndicesRef
  })
  useCombinedDiffOwnerMemory({
    owner: viewport,
    restore,
    entrySignature: entrySet.entrySignature,
    viewStateKey
  })
  const markDirectScrollInput = useCallback(() => viewport.cancelNavigation(), [viewport])
  const scrollToSectionIndex = useCallback((index: number) => viewport.navigate(index), [viewport])

  const toggleSection = useCallback(
    (index: number) => {
      const section = registry.sectionsRef.current[index]
      const shouldLoadAfterExpand = section?.collapsed ?? false
      const anchor = restore.scrollAnchorRef.current
      if (section && !section.collapsed && anchor?.key === section.key) {
        // The offset points into the body being removed; restore would land on later sections.
        anchor.offset = 0
      }
      setSections((prev) =>
        prev.map((s, i) => (i === index ? { ...s, collapsed: !s.collapsed } : s))
      )
      if (shouldLoadAfterExpand) {
        registry.loadSchedulerRef.current.request(index)
      }
    },
    [registry.loadSchedulerRef, registry.sectionsRef, restore.scrollAnchorRef]
  )

  const treeNavigation = useCombinedDiffTreeNavigation({
    ensureSectionLoaded,
    entrySignature: entrySet.entrySignature,
    markDirectScrollInput,
    scrollToIndex: scrollToSectionIndex,
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
  const {
    handleSectionSaveRef,
    modifiedEditorsRef,
    openSection,
    openSectionPreview,
    openAlternateDiff
  } = useCombinedDiffSectionActions({
    activeGroupId,
    viewStateScopeId,
    branchSummary,
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
    sectionHeights,
    sections
  })
  const { setScrollSurfaceMounted } = notes
  const setScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => setScrollSurfaceMounted(node !== null),
    [setScrollSurfaceMounted]
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
      'combined-diff-exclusion',
      editorViewPlacement(useAppStore.getState(), file, viewStateScopeId)
    )
  }, [file, viewStateScopeId, openConflictReview, skippedConflicts])

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
          commentOwner={notesView.owner}
          diffCommentsForWorktree={notesView.comments}
          diffShowWhitespace={diffShowWhitespace}
          diffWordWrap={diffWordWrap}
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
            commentOwner={notesView.owner}
            diffCommentsForWorktree={notesView.comments}
            file={file}
            handleSectionSaveRef={handleSectionSaveRef}
            isAllMode={entrySet.isAllMode}
            isBranchMode={entrySet.isBranchMode}
            isCommitMode={entrySet.isCommitMode}
            isDark={isDark}
            loadSection={loadSection}
            loadDeferredSection={loadDeferredSection}
            modifiedEditorsRef={modifiedEditorsRef}
            openSection={openSection}
            openSectionPreview={openSectionPreview}
            retrySection={retrySection}
            sectionHeights={sectionHeights}
            setScrollContainerRef={setScrollContainerRef}
            sections={sections}
            setSectionHeights={setSectionHeights}
            setSections={setSections}
            sideBySide={preferences.sideBySide}
            skippedConflictNotice={skippedConflictNotice}
            toggleSection={toggleSection}
            viewport={viewport}
          />
        </div>
      </div>
      <ClearDiffNotesDialog
        diffCommentCount={notes.clearNotesCount}
        isClearingNotes={notes.isClearingNotes}
        onConfirm={() => void notes.handleConfirmClearNotes()}
        open={notes.clearNotesDialogVisible}
        setOpen={notes.setClearNotesDialogOpen}
      />
    </>
  )
}
