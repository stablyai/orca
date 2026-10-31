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
      // Use per-section tokens: global generation is in virtualizer keys and would remount every visible Monaco editor.
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
                // Retry explicitly refetches disk and discards edits retained after a refused save.
                dirty: false,
                saveConflict: undefined,
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

  // Revalidate in place; clearing content first rebuilds Monaco even for identical refetches and stalls rebases.
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
        // The stale in-flight token schedules its reload on settlement; another schedule here would duplicate the fetch.
        return
      }
      if (section.collapsed || !renderedIndicesRef.current.has(index)) {
        // Refetch only visible expanded rows; rebases invalidate many paths, and offscreen rows reload when mounted.
        return
      }
      // Coalesce repeated path writes without postponing an armed timer, or sustained writes would starve reloads.
      if (reloadTimersRef.current.has(index)) {
        return
      }
      reloadTimersRef.current.set(
        index,
        window.setTimeout(() => {
          reloadTimersRef.current.delete(index)
          loadSchedulerRef.current.rerequest(index, { viewportOnly: true })
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
