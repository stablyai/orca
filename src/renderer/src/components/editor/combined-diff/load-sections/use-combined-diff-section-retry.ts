import { useCallback } from 'react'
import type React from 'react'
import type { DiffSection } from '../../diff-section-types'
import { removeDiffSectionMeasuredHeight } from '../../diff-section-height-cache'
import { shouldRequestCombinedDiffSectionLoad } from './combined-diff-section-load-state'
import {
  COMBINED_DIFF_SECTION_RELOAD_COALESCE_MS,
  type CombinedDiffSectionLoadRegistry
} from './combined-diff-section-load-registry'

export type CombinedDiffSectionRetryActions = {
  ensureSectionLoaded: (index: number) => void
  requestSectionReload: (index: number) => void
  retrySection: (index: number) => void
}

export function useCombinedDiffSectionRetry({
  invalidateViewStateCache,
  registry,
  setSectionHeights,
  setSections
}: {
  invalidateViewStateCache: () => void
  registry: CombinedDiffSectionLoadRegistry
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
}): CombinedDiffSectionRetryActions {
  const {
    loadSchedulerRef,
    loadedIndicesRef,
    loadingIndicesRef,
    reloadTimersRef,
    renderedIndicesRef,
    requestSectionReloadRef,
    retrySectionRef,
    sectionLoadTokensRef,
    sectionsRef
  } = registry

  const retrySection = useCallback(
    (index: number) => {
      const collapsed = sectionsRef.current[index]?.collapsed ?? false
      loadedIndicesRef.current.delete(index)
      loadingIndicesRef.current.delete(index)
      invalidateViewStateCache()
      // Why: reloading one section must not bump the global generation — that is part of
      // the virtualizer item key, so it would remount every rendered Monaco editor (STA-3420).
      sectionLoadTokensRef.current.set(index, (sectionLoadTokensRef.current.get(index) ?? 0) + 1)
      const coalesced = reloadTimersRef.current.get(index)
      if (coalesced !== undefined) {
        window.clearTimeout(coalesced)
        reloadTimersRef.current.delete(index)
      }
      setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index
            ? {
                ...section,
                loading: !collapsed,
                error: undefined,
                diffResult: null,
                originalContent: '',
                modifiedContent: '',
                largeDiffRenderLimit: null,
                contentGeneration: (section.contentGeneration ?? 0) + 1
              }
            : section
        )
      )
      if (collapsed) {
        return
      }
      loadSchedulerRef.current.rerequest(index)
    },
    [
      invalidateViewStateCache,
      loadSchedulerRef,
      loadedIndicesRef,
      loadingIndicesRef,
      reloadTimersRef,
      sectionLoadTokensRef,
      sectionsRef,
      setSectionHeights,
      setSections
    ]
  )
  retrySectionRef.current = retrySection

  // Why: invalidation (rebase/commit/external write) revalidates in place — it must not tear the
  // section down first. Clearing content up front forces a Monaco remodel even when the refetched
  // diff is identical, which is what wedged the renderer during a rebase (STA-3420).
  const requestSectionReload = useCallback(
    (index: number): void => {
      const section = sectionsRef.current[index]
      if (!section || section.dirty) {
        return
      }
      loadedIndicesRef.current.delete(index)
      invalidateViewStateCache()
      sectionLoadTokensRef.current.set(index, (sectionLoadTokensRef.current.get(index) ?? 0) + 1)
      if (loadingIndicesRef.current.has(index)) {
        // Why: the in-flight load now carries a stale token, so it re-drives this reload when it
        // settles. Scheduling one here would fetch the same large diff a second time.
        return
      }
      if (section.collapsed || !renderedIndicesRef.current.has(index)) {
        // Why: a rebase invalidates every touched path at once. Refetching off-screen sections is
        // unbounded work nobody can see; the row reloads on mount once it scrolls into view.
        return
      }
      // Why: a rebase touches the same path many times over a few seconds. Without coalescing
      // each touch refetches a whole diff, and the payload churn alone stalls the renderer.
      const pending = reloadTimersRef.current.get(index)
      if (pending !== undefined) {
        window.clearTimeout(pending)
      }
      reloadTimersRef.current.set(
        index,
        window.setTimeout(() => {
          reloadTimersRef.current.delete(index)
          loadSchedulerRef.current.rerequest(index)
        }, COMBINED_DIFF_SECTION_RELOAD_COALESCE_MS)
      )
    },
    [
      invalidateViewStateCache,
      loadSchedulerRef,
      loadedIndicesRef,
      loadingIndicesRef,
      reloadTimersRef,
      renderedIndicesRef,
      sectionLoadTokensRef,
      sectionsRef
    ]
  )
  requestSectionReloadRef.current = requestSectionReload

  const ensureSectionLoaded = useCallback(
    (index: number): void => {
      const section = sectionsRef.current[index]
      if (!shouldRequestCombinedDiffSectionLoad(section, loadingIndicesRef.current.has(index))) {
        return
      }
      loadedIndicesRef.current.delete(index)
      loadSchedulerRef.current.request(index)
    },
    [loadSchedulerRef, loadedIndicesRef, loadingIndicesRef, sectionsRef]
  )

  return { ensureSectionLoaded, requestSectionReload, retrySection }
}
