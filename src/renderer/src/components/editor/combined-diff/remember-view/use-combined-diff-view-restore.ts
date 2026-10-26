import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { DiffSection } from '../../diff-section-types'
import { buildCombinedGitStatusSignature } from '../resolve-changes/combined-diff-git-status-signature'
import { combinedDiffSectionsMatchEntryMetadata } from '../resolve-changes/combined-diff-section-cache-match'
import { getCombinedDiffFileTreeSectionKey } from '../resolve-changes/combined-diff-section-identity'
import { isCombinedDiffSectionViewed } from '../browse-files/combined-diff-file-tree-filter'
import {
  collectCountedCombinedDiffPasses,
  getCombinedDiffCountingPassKey,
  shouldLoadCombinedDiffOnDemand
} from '../../combined-diff-on-demand-load'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import type { CombinedDiffSectionLoadRegistry } from '../load-sections/combined-diff-section-load-registry'
import { clearPendingSectionReloadTimers } from '../load-sections/combined-diff-section-load-registry'
import { combinedDiffViewPreferences } from './combined-diff-view-memory'
import {
  claimCombinedDiffView,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  type CombinedDiffViewLease,
  type CombinedDiffViewSuccession
} from './combined-diff-view-cache'

export type CombinedDiffViewRestore = {
  invalidateViewStateCache: () => void
  latestDomScrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  scrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  scrollOffsetRef: React.RefObject<number>
}

export function useCombinedDiffViewRestore({
  entrySet,
  gitStatusEntries,
  registry,
  setGeneration,
  setSectionHeights,
  setSections,
  setSideBySide,
  succession,
  viewStateKey,
  worktreeId
}: {
  entrySet: CombinedDiffEntrySet
  gitStatusEntries: GitStatusEntry[]
  registry: CombinedDiffSectionLoadRegistry
  setGeneration: React.Dispatch<React.SetStateAction<number>>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  setSideBySide: React.Dispatch<React.SetStateAction<boolean>>
  /** Set for tab-scoped keys so a reopened tab restores the view its closed predecessor left. */
  succession?: CombinedDiffViewSuccession
  viewStateKey: string
  worktreeId: string
}): CombinedDiffViewRestore {
  const {
    entries,
    entrySignature,
    hasUncommittedEntriesSnapshot,
    shouldAutoReloadFromGitStatus,
    treeMode
  } = entrySet
  const {
    generationRef,
    deferredLoadRequestsRef,
    loadSchedulerRef,
    loadedIndicesRef,
    loadingIndicesRef,
    reloadTimersRef,
    sectionLoadTokensRef,
    supersededLoadIndicesRef
  } = registry

  // Lazy state reads once even when the valid seed is null; useRef(expr) or nullish guards would reread on renders.
  const [restoreSeed] = useState<{ offset: number; anchor: VirtualizedScrollAnchor }>(() => {
    // Preview inheritance before render; the later claim moves it only after virtualizer seeding.
    const memory = readCombinedDiffViewMemory(
      viewStateKey,
      succession ? { worktreeId, succession } : undefined
    )
    return { offset: memory?.scrollTop ?? 0, anchor: memory?.scrollAnchor ?? null }
  })
  const scrollOffsetRef = useRef(restoreSeed.offset)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(restoreSeed.anchor)
  const latestDomScrollAnchorRef = useRef<VirtualizedScrollAnchor>(restoreSeed.anchor)

  // Create the lease before viewer persist/scroll effects can write.
  const memoryLeaseRef = useRef<CombinedDiffViewLease | null>(null)
  const successionContentKey = succession?.contentKey
  const successionScopeId = succession?.scopeId
  const isSuccessionScopeOpen = succession?.isScopeOpen
  useLayoutEffect(() => {
    const lease = claimCombinedDiffView(
      viewStateKey,
      worktreeId,
      successionContentKey !== undefined && successionScopeId !== undefined && isSuccessionScopeOpen
        ? {
            contentKey: successionContentKey,
            scopeId: successionScopeId,
            isScopeOpen: isSuccessionScopeOpen
          }
        : undefined
    )
    memoryLeaseRef.current = lease
    return () => releaseCombinedDiffView(lease)
  }, [isSuccessionScopeOpen, successionContentKey, successionScopeId, viewStateKey, worktreeId])

  // Cache sections and scroll by pane so remount restores them before repaint.
  const initializedEntryStateRef = useRef<{
    viewStateKey: string
    entrySignature: string
    hasUncommittedEntriesSnapshot: boolean
  } | null>(null)
  useLayoutEffect(() => {
    const initializedEntryState = initializedEntryStateRef.current
    if (
      initializedEntryState?.viewStateKey === viewStateKey &&
      initializedEntryState.entrySignature === entrySignature &&
      initializedEntryState.hasUncommittedEntriesSnapshot === hasUncommittedEntriesSnapshot
    ) {
      return
    }
    initializedEntryStateRef.current = {
      viewStateKey,
      entrySignature,
      hasUncommittedEntriesSnapshot
    }
    deferredLoadRequestsRef.current.clear()
    const memory = readCombinedDiffViewMemory(viewStateKey)
    const cached = memory?.view
    const canRestoreSnapshotSectionsByKey =
      hasUncommittedEntriesSnapshot &&
      cached !== undefined &&
      combinedDiffSectionsMatchEntryMetadata({
        entries,
        sections: cached.sections,
        treeMode
      })
    const canRestoreCachedSections =
      cached &&
      (cached.entrySignature === entrySignature || canRestoreSnapshotSectionsByKey) &&
      (!shouldAutoReloadFromGitStatus ||
        (cached.gitStatusSignature ?? '') ===
          buildCombinedGitStatusSignature(cached.sections, gitStatusEntries)) &&
      (cached.sections.length > 0 || entries.length === 0)
    if (canRestoreCachedSections && cached) {
      const collapsedPreference = combinedDiffViewPreferences.collapsed
      const restoredSections =
        collapsedPreference === null
          ? cached.sections
          : cached.sections.map((section) => ({
              ...section,
              collapsed: collapsedPreference
            }))
      setSections(restoredSections)
      setSectionHeights(cached.sectionHeights)
      setSideBySide(combinedDiffViewPreferences.sideBySide ?? cached.sideBySide)
      loadedIndicesRef.current = new Set(
        cached.loadedIndices.filter((index) => {
          const section = restoredSections[index]
          return section !== undefined && isCombinedDiffSectionViewed(section)
        })
      )
      loadingIndicesRef.current.clear()
      scrollOffsetRef.current = memory.scrollTop ?? 0
      scrollAnchorRef.current = memory.scrollAnchor ?? null
      latestDomScrollAnchorRef.current = scrollAnchorRef.current
      return
    }

    scrollOffsetRef.current = memory?.scrollTop ?? 0
    scrollAnchorRef.current = memory?.scrollAnchor ?? null
    latestDomScrollAnchorRef.current = scrollAnchorRef.current
    // Count evidence belongs to each independent pass; all mode must not treat compare success as proof uncommitted rows were counted.
    const countedPasses = collectCountedCombinedDiffPasses(entries)
    setSections(
      entries.map((entry) => {
        const loadOnDemand = shouldLoadCombinedDiffOnDemand({
          added: 'added' in entry ? entry.added : undefined,
          removed: 'removed' in entry ? entry.removed : undefined,
          path: entry.path,
          area: 'area' in entry ? entry.area : undefined,
          submodule: 'submodule' in entry ? entry.submodule : undefined,
          hasCountedSiblings: countedPasses.has(getCombinedDiffCountingPassKey(entry))
        })
        return {
          key: getCombinedDiffFileTreeSectionKey(treeMode, entry),
          path: entry.path,
          status: entry.status,
          area: 'area' in entry ? entry.area : undefined,
          oldPath: entry.oldPath,
          added: 'added' in entry ? entry.added : undefined,
          removed: 'removed' in entry ? entry.removed : undefined,
          originalContent: '',
          modifiedContent: '',
          collapsed: combinedDiffViewPreferences.collapsed ?? false,
          loading: !loadOnDemand,
          loadOnDemand,
          error: undefined,
          dirty: false,
          diffResult: null,
          largeDiffRenderLimit: null
        }
      })
    )
    setSectionHeights({})
    loadedIndicesRef.current.clear()
    loadingIndicesRef.current.clear()
    sectionLoadTokensRef.current.clear()
    supersededLoadIndicesRef.current.clear()
    clearPendingSectionReloadTimers(reloadTimersRef.current)
    loadSchedulerRef.current.reset()
    generationRef.current += 1
    setGeneration((prev) => prev + 1)
  }, [
    entries,
    entrySignature,
    generationRef,
    deferredLoadRequestsRef,
    gitStatusEntries,
    hasUncommittedEntriesSnapshot,
    loadSchedulerRef,
    loadedIndicesRef,
    loadingIndicesRef,
    reloadTimersRef,
    sectionLoadTokensRef,
    supersededLoadIndicesRef,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide,
    shouldAutoReloadFromGitStatus,
    treeMode,
    viewStateKey
  ])

  const invalidateViewStateCache = useCallback((): void => {
    rememberCombinedDiffView(memoryLeaseRef.current, { view: undefined })
  }, [])

  return {
    invalidateViewStateCache,
    latestDomScrollAnchorRef,
    memoryLeaseRef,
    scrollAnchorRef,
    scrollOffsetRef
  }
}
