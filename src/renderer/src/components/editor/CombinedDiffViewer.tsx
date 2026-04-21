/* eslint-disable max-lines -- Why: combined diff behavior depends on one
component-level state machine that coordinates lazy loading, inline editing,
restore-on-remount caching, and scroll preservation. Splitting those pieces
across smaller files would make the lifecycle edges harder to reason about and
more error-prone than keeping the whole viewer flow together. */
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { setWithLRU } from '@/lib/scroll-cache'
import { getConnectionId } from '@/lib/connection-context'
import '@/lib/monaco-setup'
import { Button } from '@/components/ui/button'
import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry, GitDiffResult, GitStatusEntry } from '../../../../shared/types'
import { DiffSectionItem } from './DiffSectionItem'
import { getCombinedUncommittedEntries } from './combined-diff-entries'

type DiffSection = {
  key: string
  path: string
  status: string
  area?: GitStatusEntry['area']
  oldPath?: string
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
  dirty: boolean
  diffResult: GitDiffResult | null
}

type CachedCombinedDiffViewState = {
  entrySignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
}

const combinedDiffViewStateCache = new Map<string, CachedCombinedDiffViewState>()
const combinedDiffScrollTopCache = new Map<string, number>()

export default function CombinedDiffViewer({
  file,
  viewStateKey
}: {
  file: OpenFile
  viewStateKey: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const gitBranchCompareSummaryByWorktree = useAppStore((s) => s.gitBranchCompareSummaryByWorktree)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side')
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  // Why: `generation` is a state counter used as a React key to force remounting
  // DiffSectionItem components when the entry list changes. A separate ref
  // (`generationRef`) is kept in sync for stale-async-result detection inside
  // `loadSection`, where reading state would capture a stale closure value.
  const [generation, setGeneration] = useState(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingRestoreScrollTopRef = useRef<number | null>(null)

  // Why: When the user changes their global diff-view preference in Settings,
  // sync the local toggle to match, even if they manually toggled it this session.
  useEffect(() => {
    if (settings?.diffDefaultView !== undefined) {
      setSideBySide(settings.diffDefaultView === 'side-by-side')
    }
  }, [settings?.diffDefaultView])

  const branchSummary = gitBranchCompareSummaryByWorktree[file.worktreeId]
  const isBranchMode = file.diffSource === 'combined-branch'
  const branchCompare =
    file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
      ? file.branchCompare
      : null

  // Why: prefer the snapshot taken at tab-open time so a commit that changes
  // gitStatusByWorktree does not rebuild all sections and lose loaded content.
  // The snapshot is already area-filtered by openAllDiffs; conflict filtering
  // is applied here via snapshotEntries. The live path (getCombinedUncommittedEntries)
  // adds its own area + conflict filtering as a fallback for tabs opened before
  // the snapshot field existed.
  const snapshotEntries = React.useMemo(
    () => file.uncommittedEntriesSnapshot?.filter((e) => e.conflictStatus !== 'unresolved'),
    [file.uncommittedEntriesSnapshot]
  )
  const uncommittedEntries = React.useMemo(
    () =>
      snapshotEntries ??
      getCombinedUncommittedEntries(
        gitStatusByWorktree[file.worktreeId] ?? [],
        file.combinedAreaFilter
      ),
    [snapshotEntries, file.worktreeId, file.combinedAreaFilter, gitStatusByWorktree]
  )
  const branchEntries = React.useMemo<GitBranchChangeEntry[]>(() => {
    const snapshotEntries = file.branchEntriesSnapshot ?? []
    if (snapshotEntries.length > 0) {
      return snapshotEntries
    }
    return gitBranchChangesByWorktree[file.worktreeId] ?? []
  }, [file.branchEntriesSnapshot, file.worktreeId, gitBranchChangesByWorktree])
  const entries = isBranchMode ? branchEntries : uncommittedEntries
  const entrySignature = React.useMemo(
    () =>
      JSON.stringify({
        mode: file.diffSource,
        areaFilter: file.combinedAreaFilter ?? null,
        compareVersion: file.branchCompare?.compareVersion ?? null,
        compare:
          isBranchMode && branchCompare
            ? {
                baseOid: branchCompare.baseOid,
                headOid: branchCompare.headOid,
                mergeBase: branchCompare.mergeBase
              }
            : null,
        entries: entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          oldPath: entry.oldPath ?? null,
          area: 'area' in entry ? entry.area : null
        }))
      }),
    [
      branchCompare,
      entries,
      file.branchCompare?.compareVersion,
      file.combinedAreaFilter,
      file.diffSource,
      isBranchMode
    ]
  )

  // Why: switching tabs or worktrees unmounts this viewer through the shared
  // editor surface above it. Cache the rendered combined-diff state by the
  // visible pane key so remounting can restore loaded sections and scroll
  // position instead of flashing back to "Loading..." and forcing the user to
  // find their place again.
  useEffect(() => {
    const cached = combinedDiffViewStateCache.get(viewStateKey)
    const canRestoreCachedSections =
      cached &&
      cached.entrySignature === entrySignature &&
      (cached.sections.length > 0 || entries.length === 0)
    if (canRestoreCachedSections && cached) {
      setSections(cached.sections)
      setSectionHeights(cached.sectionHeights)
      setSideBySide(cached.sideBySide)
      loadedIndicesRef.current = new Set(cached.loadedIndices)
      pendingRestoreScrollTopRef.current =
        combinedDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      return
    }

    pendingRestoreScrollTopRef.current = combinedDiffScrollTopCache.get(viewStateKey) ?? null
    setSections(
      entries.map((entry) => ({
        key: `${'area' in entry ? entry.area : 'branch'}:${entry.path}`,
        path: entry.path,
        status: entry.status,
        area: 'area' in entry ? entry.area : undefined,
        oldPath: entry.oldPath,
        originalContent: '',
        modifiedContent: '',
        collapsed: false,
        loading: true,
        dirty: false,
        diffResult: null
      }))
    )
    setSectionHeights({})
    loadedIndicesRef.current.clear()
    generationRef.current += 1
    setGeneration((prev) => prev + 1)
  }, [entries, entrySignature, viewStateKey])

  // Progressive loading: load diff content when a section becomes visible
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const generationRef = useRef(0)
  const loadSection = useCallback(
    async (index: number) => {
      if (loadedIndicesRef.current.has(index)) {
        return
      }
      loadedIndicesRef.current.add(index)

      const gen = generationRef.current
      const entries = isBranchMode ? branchEntries : uncommittedEntries
      const entry = entries[index]
      if (!entry) {
        return
      }

      let result: GitDiffResult
      try {
        const connectionId = getConnectionId(file.worktreeId) ?? undefined
        result =
          isBranchMode && branchCompare
            ? ((await window.api.git.branchDiff({
                worktreePath: file.filePath,
                compare: {
                  baseRef: branchCompare.baseRef,
                  baseOid: branchCompare.baseOid!,
                  headOid: branchCompare.headOid!,
                  mergeBase: branchCompare.mergeBase!
                },
                filePath: entry.path,
                oldPath: entry.oldPath,
                connectionId
              })) as GitDiffResult)
            : ((await window.api.git.diff({
                worktreePath: file.filePath,
                filePath: entry.path,
                staged: 'area' in entry && entry.area === 'staged',
                connectionId
              })) as GitDiffResult)
      } catch {
        result = {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        } as GitDiffResult
      }

      setSections((prev) => {
        if (generationRef.current !== gen) {
          return prev
        }
        return prev.map((s, i) =>
          i === index
            ? {
                ...s,
                diffResult: result,
                originalContent: result.kind === 'text' ? result.originalContent : '',
                modifiedContent: result.kind === 'text' ? result.modifiedContent : '',
                loading: false
              }
            : s
        )
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      branchCompare?.baseOid,
      branchCompare?.headOid,
      branchCompare?.mergeBase,
      branchEntries,
      file.filePath,
      isBranchMode,
      uncommittedEntries
    ]
  )

  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())

  const toggleSection = useCallback((index: number) => {
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, collapsed: !s.collapsed } : s)))
  }, [])

  const handleSectionSave = useCallback(
    async (index: number) => {
      const section = sections[index]
      if (!section) {
        return
      }
      const modifiedEditor = modifiedEditorsRef.current.get(index)
      if (!modifiedEditor) {
        return
      }

      const content = modifiedEditor.getValue()
      const absolutePath = joinPath(file.filePath, section.path)
      try {
        const connectionId = getConnectionId(file.worktreeId) ?? undefined
        await window.api.fs.writeFile({ filePath: absolutePath, content, connectionId })
        setSections((prev) =>
          prev.map((s, i) => (i === index ? { ...s, modifiedContent: content, dirty: false } : s))
        )
      } catch (err) {
        console.error('Save failed:', err)
      }
    },
    [file.filePath, file.worktreeId, sections]
  )

  const handleSectionSaveRef = useRef(handleSectionSave)
  handleSectionSaveRef.current = handleSectionSave

  useEffect(() => {
    if (sections.length === 0 && entries.length > 0) {
      return
    }
    const preservedScrollTop =
      combinedDiffScrollTopCache.get(viewStateKey) ?? scrollContainerRef.current?.scrollTop ?? 0
    setWithLRU(combinedDiffViewStateCache, viewStateKey, {
      entrySignature,
      sections,
      sectionHeights,
      loadedIndices: Array.from(loadedIndicesRef.current),
      scrollTop: preservedScrollTop,
      sideBySide
    })
  }, [entries.length, entrySignature, sectionHeights, sections, sideBySide, viewStateKey])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const cached = combinedDiffViewStateCache.get(viewStateKey)
    if (cached && cached.entrySignature === entrySignature) {
      pendingRestoreScrollTopRef.current =
        combinedDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
    }

    const updateCachedScrollPosition = (): void => {
      const existing = combinedDiffViewStateCache.get(viewStateKey)
      setWithLRU(combinedDiffScrollTopCache, viewStateKey, container.scrollTop)
      if (!existing || existing.entrySignature !== entrySignature) {
        return
      }
      setWithLRU(combinedDiffViewStateCache, viewStateKey, {
        ...existing,
        scrollTop: container.scrollTop
      })
    }

    // Why: React swaps the active editor DOM during tab changes. This listener
    // must detach in the layout phase so the outgoing tab snapshots its last
    // real scroll position before the soon-to-be-removed container emits a
    // reset-to-top scroll event during teardown.
    container.addEventListener('scroll', updateCachedScrollPosition)
    return () => {
      updateCachedScrollPosition()
      container.removeEventListener('scroll', updateCachedScrollPosition)
    }
  }, [entrySignature, sections.length, viewStateKey])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const targetScrollTop = pendingRestoreScrollTopRef.current
    if (!container || targetScrollTop === null) {
      return
    }

    let frameId = 0
    let attempts = 0

    const restoreScrollPosition = (): void => {
      const liveContainer = scrollContainerRef.current
      const liveTarget = pendingRestoreScrollTopRef.current
      if (!liveContainer || liveTarget === null) {
        return
      }

      const maxScrollTop = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight)
      const nextScrollTop = Math.min(liveTarget, maxScrollTop)
      liveContainer.scrollTop = nextScrollTop
      setWithLRU(combinedDiffScrollTopCache, viewStateKey, nextScrollTop)

      if (Math.abs(liveContainer.scrollTop - liveTarget) <= 1 || maxScrollTop >= liveTarget) {
        pendingRestoreScrollTopRef.current = null
        return
      }

      attempts += 1
      if (attempts < 30) {
        frameId = window.requestAnimationFrame(restoreScrollPosition)
      }
    }

    restoreScrollPosition()
    return () => window.cancelAnimationFrame(frameId)
  }, [sectionHeights, sections, viewStateKey])

  const openAlternateDiff = useCallback(() => {
    if (!file.combinedAlternate) {
      return
    }

    if (file.combinedAlternate.source === 'combined-uncommitted') {
      openAllDiffs(file.worktreeId, file.filePath)
      return
    }

    if (branchSummary && branchSummary.status === 'ready') {
      openBranchAllDiffs(file.worktreeId, file.filePath, branchSummary, {
        source: 'combined-uncommitted'
      })
    }
  }, [branchSummary, file, openAllDiffs, openBranchAllDiffs])

  if (sections.length === 0 && (file.skippedConflicts?.length ?? 0) > 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <div className="text-sm font-medium text-foreground">
            Conflicted files are reviewed separately
          </div>
          <div className="text-xs text-muted-foreground">
            This diff view excludes unresolved conflicts because the normal two-way diff pipeline is
            not conflict-safe.
          </div>
          <div className="text-xs text-muted-foreground">
            {file.skippedConflicts!.map((entry) => entry.path).join(', ')}
          </div>
          <div className="flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                openConflictReview(
                  file.worktreeId,
                  file.filePath,
                  file.skippedConflicts!.map((entry) => ({
                    path: entry.path,
                    conflictKind: entry.conflictKind
                  })),
                  'combined-diff-exclusion'
                )
              }
            >
              Review conflicts
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No changes to display
      </div>
    )
  }

  const skippedConflictNotice =
    (file.skippedConflicts?.length ?? 0) > 0 ? (
      <div className="mx-4 mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <div className="font-medium text-foreground">Conflicted files are reviewed separately</div>
        <div className="mt-1 text-muted-foreground">
          {file.skippedConflicts!.length} unresolved conflict
          {file.skippedConflicts!.length === 1 ? '' : 's'} were excluded from this diff view.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() =>
              openConflictReview(
                file.worktreeId,
                file.filePath,
                file.skippedConflicts!.map((entry) => ({
                  path: entry.path,
                  conflictKind: entry.conflictKind
                })),
                'combined-diff-exclusion'
              )
            }
          >
            Review conflicts
          </Button>
        </div>
      </div>
    ) : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background/50 shrink-0">
        <span className="text-xs text-muted-foreground">
          {sections.length} changed files
          {isBranchMode && branchCompare ? ` vs ${branchCompare.baseRef}` : ''}
        </span>
        <div className="flex items-center gap-2">
          {file.combinedAlternate && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={openAlternateDiff}
            >
              {file.combinedAlternate.source === 'combined-branch'
                ? 'Open Branch Diff'
                : 'Open Uncommitted Diff'}
            </button>
          )}
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSections((prev) => prev.map((s) => ({ ...s, collapsed: true })))}
          >
            Collapse All
          </button>
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSections((prev) => prev.map((s) => ({ ...s, collapsed: false })))}
          >
            Expand All
          </button>
          <button
            className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSideBySide((prev) => !prev)}
          >
            {sideBySide ? 'Inline' : 'Side by Side'}
          </button>
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-auto scrollbar-editor">
        {skippedConflictNotice}
        {sections.map((section, index) => (
          <DiffSectionItem
            key={`${section.key}:${generation}`}
            section={section}
            index={index}
            isBranchMode={isBranchMode}
            sideBySide={sideBySide}
            isDark={isDark}
            settings={settings}
            sectionHeight={sectionHeights[index]}
            worktreeId={file.worktreeId}
            worktreeRoot={file.filePath}
            loadSection={loadSection}
            toggleSection={toggleSection}
            setSectionHeights={setSectionHeights}
            setSections={setSections}
            modifiedEditorsRef={modifiedEditorsRef}
            handleSectionSaveRef={handleSectionSaveRef}
          />
        ))}
      </div>
    </div>
  )
}
