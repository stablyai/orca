/* eslint-disable max-lines -- Why: combined diff behavior depends on one
component-level state machine that coordinates lazy loading, inline editing,
restore-on-remount caching, and scroll preservation. Splitting those pieces
across smaller files would make the lifecycle edges harder to reason about and
more error-prone than keeping the whole viewer flow together. */
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { editor as monacoEditor } from 'monaco-editor'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { setWithLRU } from '@/lib/scroll-cache'
import { getConnectionId } from '@/lib/connection-context'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { writeRuntimeFile } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import {
  getRuntimeGitBranchDiff,
  getRuntimeGitCommitDiff,
  getRuntimeGitDiff
} from '@/runtime/runtime-git-client'
import '@/lib/monaco-setup'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { OpenFile } from '@/store/slices/editor'
import type {
  DiffComment,
  GitBranchChangeEntry,
  GitDiffResult,
  GitStatusEntry
} from '../../../../shared/types'
import { Check, Copy, MessageSquare, Send, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { DiffSectionItem } from './DiffSectionItem'
import { getCombinedUncommittedEntries } from './combined-diff-entries'
import { getDiffSectionEstimatedHeight, isIntrinsicHeightImageDiff } from './diff-section-layout'
import type { DiffSection } from './diff-section-types'
import { getInitialCombinedDiffSectionLoadIndices } from './combined-diff-initial-section-load'
import { createCombinedDiffLoadScheduler } from './combined-diff-load-scheduler'

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
const COMBINED_DIFF_OVERSCAN = 5
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntry[] = []
const EMPTY_GIT_BRANCH_ENTRIES: GitBranchChangeEntry[] = []
let combinedDiffCollapsedPreference: boolean | null = null
let combinedDiffSideBySidePreference: boolean | null = null
// Why: local Electron IPC has no RPC timeout; a hung git diff should turn into
// a retryable row error instead of leaving the editor in "Loading..." forever.
const COMBINED_DIFF_SECTION_LOAD_TIMEOUT_MS = 30_000

class CombinedDiffSectionLoadTimeoutError extends Error {
  constructor() {
    super('Diff did not finish loading.')
    this.name = 'CombinedDiffSectionLoadTimeoutError'
  }
}

function withDiffSectionLoadTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: number | null = null

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new CombinedDiffSectionLoadTimeoutError())
    }, COMBINED_DIFF_SECTION_LOAD_TIMEOUT_MS)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  })
}

function getDiffSectionLoadErrorMessage(error: unknown): string {
  if (error instanceof CombinedDiffSectionLoadTimeoutError) {
    return 'Diff did not finish loading.'
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unable to load diff.'
}

function getInitialCombinedDiffSideBySide(diffDefaultView: string | undefined): boolean {
  return combinedDiffSideBySidePreference ?? diffDefaultView === 'side-by-side'
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
  const openFile = useAppStore((s) => s.openFile)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const openCommitDiff = useAppStore((s) => s.openCommitDiff)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  const diffCommentsForWorktree = useAppStore((s) => s.getDiffComments(file.worktreeId))
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[file.worktreeId])
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const diffCommentCount = diffCommentsForWorktree.length
  const diffCommentsPrompt = React.useMemo(
    () => formatDiffComments(diffCommentsForWorktree),
    [diffCommentsForWorktree]
  )
  const previewDiffComments = React.useMemo(
    () =>
      [...diffCommentsForWorktree]
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber)
        .slice(0, 4),
    [diffCommentsForWorktree]
  )

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(() =>
    getInitialCombinedDiffSideBySide(settings?.diffDefaultView)
  )
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [clearNotesDialogOpen, setClearNotesDialogOpen] = useState(false)
  const [isClearingNotes, setIsClearingNotes] = useState(false)
  const [notesCopied, setNotesCopied] = useState(false)
  // Why: `generation` is a state counter used as a React key to force remounting
  // DiffSectionItem components when the entry list changes. A separate ref
  // (`generationRef`) is kept in sync for stale-async-result detection inside
  // `loadSection`, where reading state would capture a stale closure value.
  const [generation, setGeneration] = useState(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const pendingRestoreScrollTopRef = useRef<number | null>(null)
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const sectionsRef = useRef<DiffSection[]>([])
  const generationRef = useRef(0)
  const loadSectionRef = useRef<(index: number) => Promise<void>>(async () => {})
  const loadSchedulerRef = useRef(
    createCombinedDiffLoadScheduler({
      loadSection: (index) => loadSectionRef.current(index)
    })
  )
  sectionsRef.current = sections

  // Why: Settings should seed combined diffs until the user picks a toolbar
  // mode in this session. After that, commit-to-commit navigation follows the
  // last toolbar choice instead of snapping back to the global default.
  useEffect(() => {
    if (settings?.diffDefaultView !== undefined && combinedDiffSideBySidePreference === null) {
      setSideBySide(settings.diffDefaultView === 'side-by-side')
    }
  }, [settings?.diffDefaultView])

  const isBranchMode = file.diffSource === 'combined-branch'
  const isCommitMode = file.diffSource === 'combined-commit'
  const branchCompare =
    file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
      ? file.branchCompare
      : null
  const commitCompare = file.commitCompare?.commitOid ? file.commitCompare : null

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
      snapshotEntries ?? getCombinedUncommittedEntries(gitStatusEntries, file.combinedAreaFilter),
    [snapshotEntries, gitStatusEntries, file.combinedAreaFilter]
  )
  const branchEntries = React.useMemo<GitBranchChangeEntry[]>(() => {
    const snapshotEntries = file.branchEntriesSnapshot ?? []
    if (snapshotEntries.length > 0) {
      return snapshotEntries
    }
    return liveBranchEntries
  }, [file.branchEntriesSnapshot, liveBranchEntries])
  const commitEntries = React.useMemo<GitBranchChangeEntry[]>(
    () => file.commitEntriesSnapshot ?? [],
    [file.commitEntriesSnapshot]
  )
  const entries = isBranchMode ? branchEntries : isCommitMode ? commitEntries : uncommittedEntries
  const entrySignature = React.useMemo(
    () =>
      JSON.stringify({
        mode: file.diffSource,
        areaFilter: file.combinedAreaFilter ?? null,
        compareVersion: file.branchCompare?.compareVersion ?? null,
        commitVersion: file.commitCompare?.compareVersion ?? null,
        compare:
          isBranchMode && branchCompare
            ? {
                baseOid: branchCompare.baseOid,
                headOid: branchCompare.headOid,
                mergeBase: branchCompare.mergeBase
              }
            : null,
        commit:
          isCommitMode && commitCompare
            ? {
                commitOid: commitCompare.commitOid,
                parentOid: commitCompare.parentOid ?? null
              }
            : null,
        entries: entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          oldPath: entry.oldPath ?? null,
          area: 'area' in entry ? entry.area : null,
          added: 'added' in entry ? (entry.added ?? null) : null,
          removed: 'removed' in entry ? (entry.removed ?? null) : null
        }))
      }),
    [
      branchCompare,
      commitCompare,
      entries,
      file.branchCompare?.compareVersion,
      file.combinedAreaFilter,
      file.commitCompare?.compareVersion,
      file.diffSource,
      isBranchMode,
      isCommitMode
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
      const collapsedPreference = combinedDiffCollapsedPreference
      const restoredSections =
        collapsedPreference === null
          ? cached.sections
          : cached.sections.map((section) => ({
              ...section,
              collapsed: collapsedPreference
            }))
      setSections(restoredSections)
      setSectionHeights(cached.sectionHeights)
      setSideBySide(combinedDiffSideBySidePreference ?? cached.sideBySide)
      loadedIndicesRef.current = new Set(
        cached.loadedIndices.filter((index) => !restoredSections[index]?.loading)
      )
      loadingIndicesRef.current.clear()
      pendingRestoreScrollTopRef.current =
        combinedDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      return
    }

    pendingRestoreScrollTopRef.current = combinedDiffScrollTopCache.get(viewStateKey) ?? null
    setSections(
      entries.map((entry) => ({
        key: `${'area' in entry ? entry.area : (file.diffSource ?? 'compare')}:${entry.path}`,
        path: entry.path,
        status: entry.status,
        area: 'area' in entry ? entry.area : undefined,
        oldPath: entry.oldPath,
        added: 'added' in entry ? entry.added : undefined,
        removed: 'removed' in entry ? entry.removed : undefined,
        originalContent: '',
        modifiedContent: '',
        collapsed: combinedDiffCollapsedPreference ?? false,
        loading: true,
        error: undefined,
        dirty: false,
        diffResult: null
      }))
    )
    setSectionHeights({})
    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    loadSchedulerRef.current.reset()
    generationRef.current += 1
    setGeneration((prev) => prev + 1)
  }, [entries, entrySignature, file.diffSource, viewStateKey])

  const loadSectionNow = useCallback(
    async (index: number) => {
      if (loadedIndicesRef.current.has(index) || loadingIndicesRef.current.has(index)) {
        return
      }
      loadingIndicesRef.current.add(index)

      const gen = generationRef.current
      const entries = isBranchMode
        ? branchEntries
        : isCommitMode
          ? commitEntries
          : uncommittedEntries
      const entry = entries[index]
      if (!entry) {
        loadingIndicesRef.current.delete(index)
        return
      }

      let result: GitDiffResult
      let error: string | undefined
      try {
        const connectionId = getConnectionId(file.worktreeId) ?? undefined
        const state = useAppStore.getState()
        const fileSettings = settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId)
        if (isBranchMode && branchCompare) {
          result = await withDiffSectionLoadTimeout(
            getRuntimeGitBranchDiff(
              {
                settings: fileSettings,
                worktreeId: file.worktreeId,
                worktreePath: file.filePath,
                connectionId
              },
              {
                compare: {
                  baseRef: branchCompare.baseRef,
                  baseOid: branchCompare.baseOid!,
                  headOid: branchCompare.headOid!,
                  mergeBase: branchCompare.mergeBase!
                },
                filePath: entry.path,
                oldPath: entry.oldPath
              }
            )
          )
        } else if (isCommitMode && commitCompare) {
          result = await withDiffSectionLoadTimeout(
            getRuntimeGitCommitDiff(
              {
                settings: fileSettings,
                worktreeId: file.worktreeId,
                worktreePath: file.filePath,
                connectionId
              },
              {
                commitOid: commitCompare.commitOid,
                parentOid: commitCompare.parentOid,
                filePath: entry.path,
                oldPath: entry.oldPath
              }
            )
          )
        } else {
          result = await withDiffSectionLoadTimeout(
            getRuntimeGitDiff(
              {
                settings: fileSettings,
                worktreeId: file.worktreeId,
                worktreePath: file.filePath,
                connectionId
              },
              {
                filePath: entry.path,
                staged: 'area' in entry && entry.area === 'staged'
              }
            )
          )
        }
      } catch (err) {
        error = getDiffSectionLoadErrorMessage(err)
        result = {
          kind: 'text',
          originalContent: '',
          modifiedContent: '',
          originalIsBinary: false,
          modifiedIsBinary: false
        } as GitDiffResult
      }

      loadingIndicesRef.current.delete(index)
      if (generationRef.current !== gen) {
        return
      }
      loadedIndicesRef.current.add(index)
      setSections((prev) => {
        return prev.map((s, i) =>
          i === index
            ? {
                ...s,
                diffResult: result,
                originalContent: result.kind === 'text' ? result.originalContent : '',
                modifiedContent: result.kind === 'text' ? result.modifiedContent : '',
                loading: false,
                error
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
      commitCompare?.commitOid,
      commitCompare?.parentOid,
      commitEntries,
      file.filePath,
      file.runtimeEnvironmentId,
      isBranchMode,
      isCommitMode,
      uncommittedEntries
    ]
  )
  loadSectionRef.current = loadSectionNow

  useEffect(() => {
    // Why: React StrictMode replays effect cleanup during development. Resetting
    // here revives the scheduler for the replayed mount instead of leaving all
    // later visibility requests ignored.
    const scheduler = loadSchedulerRef.current
    scheduler.reset()
    return () => scheduler.dispose()
  }, [])

  // Progressive loading: queue diff content when a section becomes visible.
  const loadSection = useCallback((index: number) => {
    if (sectionsRef.current[index]?.collapsed) {
      return
    }
    loadSchedulerRef.current.request(index)
  }, [])

  useEffect(() => {
    // Why: VS Code's multi-diff resolves an initial resource model before
    // virtualizing editors. Queue the first rows deterministically so the
    // visible viewport is not dependent on IntersectionObserver delivery.
    const currentSections = sectionsRef.current
    for (let index = 0; index < currentSections.length; index += 1) {
      if (currentSections[index]?.loading && loadedIndicesRef.current.has(index)) {
        loadedIndicesRef.current.delete(index)
      }
    }

    const initialIndices = getInitialCombinedDiffSectionLoadIndices({
      sectionCount: currentSections.length,
      loadedIndices: loadedIndicesRef.current
    })

    for (const index of initialIndices) {
      if (!currentSections[index]?.collapsed) {
        loadSection(index)
      }
    }
  }, [entrySignature, loadSection, sections.length])

  const retrySection = useCallback(
    (index: number) => {
      loadedIndicesRef.current.delete(index)
      loadingIndicesRef.current.delete(index)
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index
            ? {
                ...section,
                loading: true,
                error: undefined,
                diffResult: null,
                originalContent: '',
                modifiedContent: ''
              }
            : section
        )
      )
      loadSection(index)
    },
    [loadSection]
  )

  const modifiedEditorsRef = useRef<Map<number, monacoEditor.IStandaloneCodeEditor>>(new Map())

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
        useIntrinsicImageHeight: isIntrinsicHeightImageDiff(section.diffResult)
      })
    },
    overscan: COMBINED_DIFF_OVERSCAN,
    getItemKey: (index) => {
      const section = sections[index]
      if (!section) {
        return `${index}:${generation}`
      }
      return `${section.key}:${section.collapsed ? 'collapsed' : 'expanded'}:${generation}`
    }
  })

  useLayoutEffect(() => {
    // Why: inline vs side-by-side can change Monaco content heights across
    // every loaded row. Re-measure on this explicit mode change, not on every
    // section load.
    virtualizer.measure()
  }, [sideBySide, virtualizer])

  const toggleSection = useCallback((index: number) => {
    const shouldLoadAfterExpand = sectionsRef.current[index]?.collapsed ?? false
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, collapsed: !s.collapsed } : s)))
    if (shouldLoadAfterExpand) {
      loadSchedulerRef.current.request(index)
    }
  }, [])

  const setAllSectionsCollapsed = useCallback((collapsed: boolean) => {
    combinedDiffCollapsedPreference = collapsed
    setSections((prev) => prev.map((section) => ({ ...section, collapsed })))
    if (!collapsed) {
      const initialIndices = getInitialCombinedDiffSectionLoadIndices({
        sectionCount: sectionsRef.current.length,
        loadedIndices: loadedIndicesRef.current
      })
      for (const index of initialIndices) {
        loadSchedulerRef.current.request(index)
      }
    }
  }, [])

  const toggleSideBySide = useCallback(() => {
    setSideBySide((prev) => {
      const next = !prev
      combinedDiffSideBySidePreference = next
      return next
    })
  }, [])

  const openSection = useCallback(
    (index: number) => {
      const section = sectionsRef.current[index]
      if (!section) {
        return
      }

      const language = detectLanguage(section.path)
      const entry: GitBranchChangeEntry = {
        path: section.path,
        status: section.status as GitBranchChangeEntry['status'],
        oldPath: section.oldPath,
        added: section.added,
        removed: section.removed
      }

      if (isBranchMode && branchCompare) {
        openBranchDiff(file.worktreeId, file.filePath, entry, branchCompare, language)
        return
      }

      if (isCommitMode && commitCompare) {
        openCommitDiff(file.worktreeId, file.filePath, entry, commitCompare, language)
        return
      }

      openFile({
        filePath: joinPath(file.filePath, section.path),
        relativePath: section.path,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId,
        language,
        mode: 'edit'
      })
    },
    [
      branchCompare,
      commitCompare,
      file.filePath,
      file.runtimeEnvironmentId,
      file.worktreeId,
      isBranchMode,
      isCommitMode,
      openBranchDiff,
      openCommitDiff,
      openFile
    ]
  )

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
        const state = useAppStore.getState()
        const worktree = file.worktreeId
          ? findWorktreeById(state.worktreesByRepo, file.worktreeId)
          : null
        await writeRuntimeFile(
          {
            settings: settingsForRuntimeOwner(state.settings, file.runtimeEnvironmentId),
            worktreeId: file.worktreeId,
            worktreePath: worktree?.path ?? null,
            connectionId
          },
          absolutePath,
          content
        )
        setSections((prev) =>
          prev.map((s, i) => {
            if (i !== index) {
              return s
            }

            return {
              ...s,
              modifiedContent: content,
              dirty: false,
              diffResult:
                s.diffResult?.kind === 'text'
                  ? { ...s.diffResult, modifiedContent: content }
                  : s.diffResult
            }
          })
        )
      } catch (err) {
        console.error('Save failed:', err)
      }
    },
    [file.filePath, file.runtimeEnvironmentId, file.worktreeId, sections]
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
      loadedIndices: Array.from(loadedIndicesRef.current).filter(
        (index) => !sections[index]?.loading
      ),
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

  useEffect(() => {
    if (diffCommentCount === 0 && !isClearingNotes) {
      setClearNotesDialogOpen(false)
    }
  }, [diffCommentCount, isClearingNotes])

  useEffect(() => {
    if (!notesCopied) {
      return
    }
    const handle = window.setTimeout(() => setNotesCopied(false), 1500)
    return () => window.clearTimeout(handle)
  }, [notesCopied])

  const handleCopyNotes = useCallback(async (): Promise<void> => {
    if (diffCommentCount === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(diffCommentsPrompt)
      setNotesCopied(true)
    } catch {
      // Why: clipboard writes can fail while the app is not focused; this
      // mirrors the sidebar notes action and keeps the popover non-blocking.
    }
  }, [diffCommentCount, diffCommentsPrompt])

  const handleConfirmClearNotes = useCallback(async (): Promise<void> => {
    if (diffCommentCount === 0 || isClearingNotes) {
      return
    }
    setIsClearingNotes(true)
    try {
      const ok = await clearDiffComments(file.worktreeId)
      if (ok) {
        setClearNotesDialogOpen(false)
      } else {
        toast.error('Failed to clear notes.')
      }
    } finally {
      setIsClearingNotes(false)
    }
  }, [clearDiffComments, diffCommentCount, file.worktreeId, isClearingNotes])

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
  const allSectionsCollapsed = sections.every((section) => section.collapsed)

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-border bg-background/50 shrink-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {sections.length} changed files
              {isBranchMode && branchCompare ? ` vs ${branchCompare.baseRef}` : ''}
              {isCommitMode && commitCompare ? ` in ${commitCompare.compareRef}` : ''}
            </span>
            {diffCommentCount > 0 && (
              <div className="ml-2 flex shrink-0 items-center overflow-hidden rounded-md border border-border/60 bg-muted/20">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-7 items-center gap-1 px-2 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Show ${diffCommentCount} AI ${diffCommentCount === 1 ? 'note' : 'notes'}`}
                    >
                      <MessageSquare className="size-3" />
                      AI notes
                      <span className="tabular-nums">{diffCommentCount}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" side="bottom" sideOffset={6} className="w-80 p-0">
                    <DiffNotesPreviewPopover
                      comments={previewDiffComments}
                      totalCount={diffCommentCount}
                      copied={notesCopied}
                      onCopy={() => void handleCopyNotes()}
                      onClear={() => setClearNotesDialogOpen(true)}
                    />
                  </PopoverContent>
                </Popover>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="h-7 rounded-none border-l border-border/60 text-muted-foreground hover:text-foreground"
                          aria-label="Send AI notes to a new agent"
                        >
                          <Send className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Send notes to AI
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    <QuickLaunchAgentMenuItems
                      worktreeId={file.worktreeId}
                      groupId={activeGroupId ?? file.worktreeId}
                      onFocusTerminal={focusTerminalTabSurface}
                      prompt={diffCommentsPrompt}
                      launchSource="notes_send"
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
              className="w-20 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAllSectionsCollapsed(!allSectionsCollapsed)}
            >
              {allSectionsCollapsed ? 'Expand All' : 'Collapse All'}
            </button>
            <button
              className="w-24 px-2 py-0.5 text-center text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
              onClick={toggleSideBySide}
            >
              {sideBySide ? 'Inline' : 'Side by Side'}
            </button>
          </div>
        </div>

        <div ref={scrollContainerRef} className="flex-1 overflow-auto scrollbar-editor">
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
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  // Why: `top` preserves sticky file headers inside each row;
                  // transform-based virtualization creates a containing block
                  // that makes long-section headers feel jumpy while scrolling.
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
                    retrySection={retrySection}
                    toggleSection={toggleSection}
                    openSection={openSection}
                    openSectionTitle={isBranchMode || isCommitMode ? 'Open diff' : 'Open in editor'}
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
      <Dialog
        open={clearNotesDialogOpen}
        onOpenChange={(open) => {
          if (!open && !isClearingNotes) {
            setClearNotesDialogOpen(false)
          } else if (open) {
            setClearNotesDialogOpen(true)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Clear Notes</DialogTitle>
            <DialogDescription className="text-xs">
              Clear {diffCommentCount} {diffCommentCount === 1 ? 'note' : 'notes'} from this
              worktree?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setClearNotesDialogOpen(false)}
              disabled={isClearingNotes}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmClearNotes()}
              disabled={isClearingNotes || diffCommentCount === 0}
            >
              <Trash2 className="size-4" />
              Clear Notes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DiffNotesPreviewPopover({
  comments,
  totalCount,
  copied,
  onCopy,
  onClear
}: {
  comments: DiffComment[]
  totalCount: number
  copied: boolean
  onCopy: () => void
  onClear: () => void
}): React.JSX.Element {
  const remainingCount = Math.max(0, totalCount - comments.length)

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          <span>AI notes</span>
          <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
            {totalCount}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 text-muted-foreground hover:text-foreground"
            onClick={onCopy}
            disabled={totalCount === 0}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            Copy
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 text-muted-foreground hover:text-destructive"
            onClick={onClear}
            disabled={totalCount === 0}
          >
            <Trash2 className="size-3" />
            Clear
          </Button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto p-2">
        {comments.map((comment) => (
          <div key={comment.id} className="rounded-md px-2 py-1.5 hover:bg-accent/50">
            <div className="flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
              <span className="min-w-0 flex-1 truncate font-mono">{comment.filePath}</span>
              <span className="shrink-0 tabular-nums">
                {getDiffCommentLineLabel(comment, true)}
              </span>
            </div>
            <div className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap break-words text-[12px] leading-snug text-foreground">
              {comment.body}
            </div>
          </div>
        ))}
        {remainingCount > 0 && (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">
            {remainingCount} more {remainingCount === 1 ? 'note' : 'notes'} in Source Control
          </div>
        )}
      </div>
    </div>
  )
}
