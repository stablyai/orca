import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import {
  CombinedDiffFileTree,
  createCombinedDiffSectionIndexMap,
  handleCombinedDiffFileTreeNavigation
} from '@/components/editor/CombinedDiffFileTree'
import {
  getDiffSectionEstimatedHeight,
  isIntrinsicHeightImageDiff
} from '@/components/editor/diff-section-layout'
import type { DiffSection } from '@/components/editor/diff-section-types'
import {
  getCombinedDiffBranchEntriesInTreeOrder,
  type CombinedDiffFileTreeEntry
} from '@/components/editor/combined-diff-file-tree-model'
import { PRViewedCheckbox } from '@/components/github/PRViewedCheckbox'
import { isPRFileViewed } from '@/components/github/pr-file-content-size'
import {
  PR_DIFF_OVERSCAN,
  getPRFileSectionKey,
  gitHubPRFileToBranchEntry,
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
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
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
    // Why: diffEntrySignature captures every file field that feeds the branch entries,
    // so memoizing on it (not the files array identity) preserves the old ref-cache
    // dedupe without writing a ref during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [diffEntrySignature]
  )
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files])
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
  const scrollContainerRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
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
      pendingRestoreScrollTopRef.current =
        prFilesDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      return
    }

    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    pendingRestoreScrollTopRef.current = prFilesDiffScrollTopCache.get(viewStateKey) ?? null
    setSections(
      entries.map((entry) => ({
        key: getPRFileSectionKey(entry.path),
        path: entry.path,
        oldPath: entry.oldPath,
        status: entry.status,
        added: entry.added,
        removed: entry.removed,
        originalContent: '',
        modifiedContent: '',
        collapsed: false,
        loading: true,
        error: undefined,
        dirty: false,
        diffResult: null,
        largeDiffRenderLimit: null
      }))
    )
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
  const sectionIndexByKey = useMemo(() => createCombinedDiffSectionIndexMap(sections), [sections])
  const visibleActiveTreeSectionKey =
    activeTreeSectionKey && sectionIndexByKey.has(activeTreeSectionKey)
      ? activeTreeSectionKey
      : null
  const viewedSectionKeys = useMemo(
    () => new Set(files.filter(isPRFileViewed).map((file) => getPRFileSectionKey(file.path))),
    [files]
  )

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const section = sections[index]
      if (!section) {
        return 88
      }
      return getDiffSectionEstimatedHeight({
        collapsed: section.collapsed,
        measuredContentHeight: sectionHeights[index],
        originalContent: section.originalContent,
        modifiedContent: section.modifiedContent,
        changedLineCount:
          section.added === undefined && section.removed === undefined
            ? undefined
            : (section.added ?? 0) + (section.removed ?? 0),
        useIntrinsicImageHeight: isIntrinsicHeightImageDiff(section.diffResult),
        isLargeDiffLimited: section.largeDiffRenderLimit?.limited === true,
        lineCounts: section.largeDiffRenderLimit?.lineCounts ?? undefined
      })
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
    scrollContainerRef,
    pendingRestoreScrollTopRef
  })

  const handleTreeNavigate = useCallback(
    (entry: CombinedDiffFileTreeEntry) => {
      const navigatedIndex = handleCombinedDiffFileTreeNavigation({
        mode: 'commit',
        entry,
        sections: sectionsRef.current,
        sectionIndexByKey,
        toggleSection,
        scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'start' })
      })
      if (navigatedIndex !== null) {
        setActiveTreeSectionKey(sectionsRef.current[navigatedIndex]?.key ?? null)
      }
    },
    [sectionIndexByKey, setActiveTreeSectionKey, toggleSection, virtualizer]
  )

  const openFilesOnGitHub = useCallback(() => {
    void window.api.shell.openUrl(`${prUrl.replace(/\/$/, '')}/files`)
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
        <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-auto scrollbar-editor">
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
                    openSectionTitle="Open files on GitHub"
                    renderHeaderTrailingContent={renderViewedCheckbox}
                    onAddLineComment={handleAddLineComment}
                    addLineCommentLabel="Comment"
                    addLineCommentPlaceholder="Add a review comment"
                    getCommentableLineNumbers={(current) =>
                      fileByPath.get(current.path)?.reviewCommentLineNumbers
                    }
                    setSectionHeights={setSectionHeights}
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
