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
import {
  combinedDiffScrollAnchorCache,
  combinedDiffScrollTopCache,
  combinedDiffViewPreferences,
  combinedDiffViewStateCache
} from './combined-diff-view-memory'

export type CombinedDiffViewRestore = {
  invalidateViewStateCache: () => void
  latestDomScrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
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
  viewStateKey
}: {
  entrySet: CombinedDiffEntrySet
  gitStatusEntries: GitStatusEntry[]
  registry: CombinedDiffSectionLoadRegistry
  setGeneration: React.Dispatch<React.SetStateAction<number>>
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  setSideBySide: React.Dispatch<React.SetStateAction<boolean>>
  viewStateKey: string
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
    sectionLoadTokensRef
  } = registry

  // Why useState and not `useRef(expr)`: the latter re-reads all three caches on every render and
  // throws the result away, and an anchor seeds legitimately to null so a nullish guard would keep
  // re-reading. useState's initializer runs once without writing a ref during render.
  const [restoreSeed] = useState<{ offset: number; anchor: VirtualizedScrollAnchor }>(() => ({
    offset: combinedDiffScrollTopCache.get(viewStateKey) ?? 0,
    anchor: combinedDiffScrollAnchorCache.get(viewStateKey) ?? null
  }))
  const scrollOffsetRef = useRef(restoreSeed.offset)
  const scrollAnchorRef = useRef<VirtualizedScrollAnchor>(restoreSeed.anchor)
  const latestDomScrollAnchorRef = useRef<VirtualizedScrollAnchor>(restoreSeed.anchor)

  // Why: tab/worktree switches unmount this viewer; cache by pane key so remount restores sections+scroll before repaint.
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
    const cached = combinedDiffViewStateCache.get(viewStateKey)
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
      scrollOffsetRef.current = combinedDiffScrollTopCache.get(viewStateKey) ?? cached.scrollTop
      scrollAnchorRef.current = combinedDiffScrollAnchorCache.get(viewStateKey) ?? null
      latestDomScrollAnchorRef.current = scrollAnchorRef.current
      return
    }

    scrollOffsetRef.current = combinedDiffScrollTopCache.get(viewStateKey) ?? 0
    scrollAnchorRef.current = combinedDiffScrollAnchorCache.get(viewStateKey) ?? null
    latestDomScrollAnchorRef.current = scrollAnchorRef.current
    // Why: separates "this row is uncounted" from "this pass skipped counting",
    // which decides whether an uncounted row is cheap. Per pass, not per view:
    // `all` mode merges passes that fail independently, so a counted branch row
    // must not vouch for an uncommitted pass that counted nothing.
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
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide,
    shouldAutoReloadFromGitStatus,
    treeMode,
    viewStateKey
  ])

  const invalidateViewStateCache = useCallback((): void => {
    combinedDiffViewStateCache.delete(viewStateKey)
  }, [viewStateKey])

  return {
    invalidateViewStateCache,
    latestDomScrollAnchorRef,
    scrollAnchorRef,
    scrollOffsetRef
  }
}
