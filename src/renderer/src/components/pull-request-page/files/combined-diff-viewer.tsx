import {
  useCombinedDiffExtent,
  useCombinedDiffViewport
} from '@/components/editor/use-combined-diff-extent'
import {
  publishCombinedDiffMeasurements,
  observeCombinedDiffOffset,
  scrollCombinedDiffToOffset,
  scrollCombinedDiffToIndex
} from '@/components/editor/combined-diff-extent-dom'
import { useCombinedDiffFocusRange } from '@/components/editor/use-combined-diff-focus-range'
import {
  combinedDiffViewportAttributes,
  combinedDiffRowAttributes
} from '@/components/editor/combined-diff-viewport'
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { editor as monacoEditor } from 'monaco-editor'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import { CombinedDiffFileTree } from '../../editor/combined-diff/browse-files/combined-diff-file-tree'
import { useCombinedDiffSectionIndexMap } from '../../editor/combined-diff/resolve-changes/use-combined-diff-section-index-map'
import { handleCombinedDiffFileTreeNavigation } from '../../editor/combined-diff/browse-files/combined-diff-file-tree-navigation'
import { getDiffSectionRowEstimatedHeight } from '@/components/editor/diff-section-layout'
import type { DiffSection } from '@/components/editor/diff-section-types'
import { getCombinedDiffBranchEntriesInTreeOrder } from '../../editor/combined-diff/browse-files/combined-diff-file-tree-filter'
import type { CombinedDiffFileTreeEntry } from '../../editor/combined-diff/resolve-changes/combined-diff-section-identity'
import { PRViewedCheckbox } from '@/components/github/PRViewedCheckbox'
import { isPRFileViewed } from '@/components/github/pr-file-content-size'
import {
  PR_DIFF_OVERSCAN,
  getPRFileSectionKey,
  gitHubPRFileToBranchEntry,
  createPRFileDiffSections,
  type PRFilesCombinedDiffViewerProps
} from '@/components/github/pr-file-diff-mapping'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { prFilesDiffScrollTopCache, prFilesDiffViewStateCache } from '../cache/files-diff-view'
import { PRFilesDiffToolbar } from './toolbar'
import { addPullRequestLineComment } from './line-comment'
import { usePRFileSectionLoader } from './section-loader'
import { usePRFilesDiffViewPersistence } from './view-restore'
import { buildInlineReviewComments } from './inline-comments'
import { usePRFileSectionHeights } from './section-heights'
import { usePRFileActiveSection } from './active-section'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export function PRFilesCombinedDiffViewer({
  files,
  comments,
  repoPath,
  repoId,
  sourceContext,
  prNumber,
  prRepo,
  prUrl,
  headSha,
  baseSha,
  pendingViewedPaths,
  onCommentAdded,
  onViewedChange
}: PRFilesCombinedDiffViewerProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark = useDocumentDarkTheme()
  const diffEntrySignature = useMemo(
    () =>
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          oldPath: file.oldPath ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          isBinary: file.isBinary
        }))
      ),
    [files]
  )
  const entries = useMemo(
    () => getCombinedDiffBranchEntriesInTreeOrder('commit', files.map(gitHubPRFileToBranchEntry)),
    // The signature captures branch-entry inputs; avoid array-identity churn without render-phase ref writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diffEntrySignature]
  )
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
  // Why: an inline arrow here re-keys every mounted row's comment decorator on every render.
  const getCommentableLineNumbers = useCallback(
    (section: DiffSection): readonly number[] | undefined =>
      fileByPath.get(section.path)?.reviewCommentLineNumbers,
    [fileByPath]
  )
  const inlineReviewComments = useMemo(
    () => buildInlineReviewComments(comments, repoId, prNumber),
    [comments, prNumber, repoId]
  )
  // Why: section contents are fetched through sourceContext, so local and remote hosts must not share cache entries.
  const sourceScope = sourceContext?.hostId ?? LOCAL_EXECUTION_HOST_ID
  const entrySignature = useMemo(
    () =>
      JSON.stringify({
        repoId,
        prNumber,
        prRepo: prRepo ? githubRepoIdentityKey(prRepo) : null,
        sourceScope,
        headSha: headSha ?? null,
        baseSha: baseSha ?? null,
        files: diffEntrySignature
      }),
    [baseSha, diffEntrySignature, headSha, prNumber, prRepo, repoId, sourceScope]
  )
  const viewStateKey = useMemo(
    () =>
      [repoId || repoPath, prNumber, prRepo ? githubRepoIdentityKey(prRepo) : '', sourceScope].join(
        '\0'
      ),
    [prNumber, prRepo, repoId, repoPath, sourceScope]
  )
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(false)
  const [fileTreeCollapsed, setFileTreeCollapsed] = useState(false)
  const [sectionHeights, setSectionHeights] = usePRFileSectionHeights(entrySignature)
  const [activeTreeSectionKey, setActiveTreeSectionKey] = usePRFileActiveSection(entrySignature)
  // Why: short virtualizer-key token; entrySignature serializes every file and would be copied into every item key.
  const [entryRevision, setEntryRevision] = useState(0)
  const { scrollContainerRef, viewportNode, setViewport, beforeDetachRef, releaseViewport } =
    useCombinedDiffViewport()
  const pendingRestoreScrollTopRef = useRef<number | null>(null)
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const sectionsRef = useRef<DiffSection[]>([])
  const generationRef = useRef(0)
  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())
  const handleSectionSaveRef = useRef<(index: number) => Promise<void>>(async () => {})
  useLayoutEffect(() => {
    // Why: keep the loader/navigation callbacks reading the latest sections without a render-phase ref write.
    sectionsRef.current = sections
  })

  const restoredContextRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const restoringContext = restoredContextRef.current !== viewStateKey
    restoredContextRef.current = viewStateKey
    // Why: bump generation so stale async diff loads from the previous view can't patch the restored sections.
    generationRef.current += 1
    setEntryRevision((revision) => revision + 1)
    const cached = prFilesDiffViewStateCache.get(viewStateKey)
    if (cached && cached.entrySignature === entrySignature) {
      const restoredSections = cached.sections
      loadedIndicesRef.current = new Set(
        cached.loadedIndices.filter((index) => !restoredSections[index]?.loading)
      )
      loadingIndicesRef.current.clear()
      setSections(restoredSections)
      setSectionHeights(cached.sectionHeights)
      setSideBySide(cached.sideBySide)
      setFileTreeCollapsed(cached.fileTreeCollapsed)
      setActiveTreeSectionKey(cached.activeTreeSectionKey)
      if (restoringContext) {
        pendingRestoreScrollTopRef.current =
          prFilesDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      }
      return
    }

    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    if (restoringContext) {
      pendingRestoreScrollTopRef.current = prFilesDiffScrollTopCache.get(viewStateKey) ?? 0
    }
    setSections(createPRFileDiffSections(entries))
  }, [entries, entrySignature, setActiveTreeSectionKey, setSectionHeights, viewStateKey])

  const { loadSection, retrySection, toggleSection, setAllSectionsCollapsed } =
    usePRFileSectionLoader({
      sectionsRef,
      loadedIndicesRef,
      loadingIndicesRef,
      generationRef,
      fileByPath,
      repoPath,
      repoId,
      sourceContext,
      prNumber,
      prRepo,
      headSha,
      baseSha,
      setSections,
      setSectionHeights
    })

  const allSectionsCollapsed = sections.length > 0 && sections.every((section) => section.collapsed)
  const sectionIndexByKey = useCombinedDiffSectionIndexMap({ entrySignature, sections })
  const visibleActiveTreeSectionKey =
    activeTreeSectionKey && sectionIndexByKey.has(activeTreeSectionKey)
      ? activeTreeSectionKey
      : null
  const viewedSectionKeys = useMemo(
    () => new Set(files.filter(isPRFileViewed).map((file) => getPRFileSectionKey(file.path))),
    [files]
  )

  const rangeExtractor = useCombinedDiffFocusRange(scrollContainerRef)
  const virtualizer = useVirtualizer({
    rangeExtractor,
    onChange: (instance) => publishCombinedDiffMeasurements(instance, sections),
    observeElementOffset: observeCombinedDiffOffset,
    scrollToFn: (offset, options, instance) =>
      scrollCombinedDiffToOffset(instance, offset + (options.adjustments ?? 0)),
    count: sections.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const section = sections[index]
      if (!section) {
        return 88
      }
      return getDiffSectionRowEstimatedHeight(section, sectionHeights[index])
    },
    overscan: PR_DIFF_OVERSCAN,
    getItemKey: (index) => {
      const section = sections[index]
      return section
        ? `${section.key}:${section.collapsed ? 'collapsed' : 'expanded'}:${entryRevision}`
        : `${index}:${entryRevision}`
    }
  })

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [sideBySide, virtualizer])

  usePRFilesDiffViewPersistence({
    sections,
    entriesLength: entries.length,
    viewStateKey,
    entrySignature,
    sectionHeights,
    sideBySide,
    fileTreeCollapsed,
    activeTreeSectionKey: visibleActiveTreeSectionKey,
    loadedIndicesRef,
    viewportNode,
    beforeDetachRef,
    releaseViewport,
    pendingRestoreScrollTopRef
  })

  useCombinedDiffExtent(viewportNode, virtualizer, undefined, sections, viewStateKey)

  const handleTreeNavigate = useCallback(
    (entry: CombinedDiffFileTreeEntry) => {
      const navigatedIndex = handleCombinedDiffFileTreeNavigation({
        mode: 'commit',
        entry,
        sections: sectionsRef.current,
        sectionIndexByKey,
        toggleSection,
        scrollToIndex: (index) => scrollCombinedDiffToIndex(virtualizer, index)
      })
      if (navigatedIndex !== null) {
        setActiveTreeSectionKey(sectionsRef.current[navigatedIndex]?.key ?? null)
      }
    },
    [sectionIndexByKey, setActiveTreeSectionKey, toggleSection, virtualizer]
  )

  const openFilesOnGitHub = useCallback(() => {
    openAppHttpLink(`${prUrl.replace(/\/$/, '')}/files`)
  }, [prUrl])

  const handleAddLineComment = useCallback(
    async (
      section: DiffSection,
      {
        lineNumber,
        startLine,
        body
      }: {
        lineNumber: number
        startLine?: number
        body: string
      }
    ) =>
      addPullRequestLineComment({
        headSha,
        section,
        lineNumber,
        startLine,
        body,
        repoPath,
        repoId,
        sourceContext,
        prNumber,
        prRepo,
        onCommentAdded
      }),
    [headSha, onCommentAdded, prNumber, prRepo, repoId, repoPath, sourceContext]
  )

  const renderViewedCheckbox = useCallback(
    (section: DiffSection) => {
      const file = fileByPath.get(section.path)
      if (!file) {
        return null
      }
      const viewed = isPRFileViewed(file)
      const pending = pendingViewedPaths.has(file.path)
      return (
        <PRViewedCheckbox
          checked={viewed}
          pending={pending}
          filePath={file.path}
          onToggle={() => {
            if (!pending) {
              void onViewedChange(file.path, !viewed)
            }
          }}
        />
      )
    },
    [fileByPath, onViewedChange, pendingViewedPaths]
  )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PRFilesDiffToolbar
        files={files}
        fileTreeCollapsed={fileTreeCollapsed}
        allSectionsCollapsed={allSectionsCollapsed}
        sideBySide={sideBySide}
        onShowFileTree={() => setFileTreeCollapsed(false)}
        onToggleAllCollapsed={() => setAllSectionsCollapsed(!allSectionsCollapsed)}
        onToggleSideBySide={() => setSideBySide((prev) => !prev)}
      />
      <div className="flex min-h-0 flex-1">
        <CombinedDiffFileTree
          mode="commit"
          worktreePath={repoPath}
          entries={entries}
          sectionIndexByKey={sectionIndexByKey}
          activeSectionKey={visibleActiveTreeSectionKey}
          viewedSectionKeys={viewedSectionKeys}
          collapsed={fileTreeCollapsed}
          onCollapsedChange={setFileTreeCollapsed}
          onNavigate={handleTreeNavigate}
        />
        <div
          {...combinedDiffViewportAttributes}
          style={{ overflowAnchor: 'none' }}
          ref={setViewport}
          className="min-w-0 flex-1 overflow-auto scrollbar-editor"
        >
          <div data-combined-diff-extent className="relative w-full">
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const section = sections[virtualItem.index]
              if (!section) {
                return null
              }
              return (
                <div
                  key={virtualItem.key}
                  {...combinedDiffRowAttributes}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ top: `${virtualItem.start}px` }}
                >
                  <DiffSectionItem
                    section={section}
                    index={virtualItem.index}
                    isBranchMode={false}
                    sideBySide={sideBySide}
                    isDark={isDark}
                    settings={settings}
                    sectionHeight={sectionHeights[virtualItem.index]}
                    worktreeId={`github-pr:${repoId}:${prNumber}`}
                    inlineComments={inlineReviewComments}
                    loadSection={loadSection}
                    retrySection={retrySection}
                    toggleSection={toggleSection}
                    openSection={openFilesOnGitHub}
                    openSectionTitle={translate(
                      'auto.components.GitHubItemDialog.85a2b66f54',
                      'Open files on GitHub'
                    )}
                    renderHeaderTrailingContent={renderViewedCheckbox}
                    onAddLineComment={handleAddLineComment}
                    addLineCommentLabel={translate(
                      'auto.components.GitHubItemDialog.bf43425540',
                      'Comment'
                    )}
                    addLineCommentPlaceholder={translate(
                      'auto.components.GitHubItemDialog.86d84a17ca',
                      'Add a review comment'
                    )}
                    getCommentableLineNumbers={getCommentableLineNumbers}
                    setSectionHeights={setSectionHeights}
                    measureSection={virtualizer.measureElement}
                    setSections={setSections}
                    modifiedEditorsRef={modifiedEditorsRef}
                    handleSectionSaveRef={handleSectionSaveRef}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
