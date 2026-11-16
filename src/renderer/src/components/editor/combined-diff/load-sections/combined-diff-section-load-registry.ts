import { useEffect, useRef } from 'react'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import {
  createCombinedDiffLoadScheduler,
  type CombinedDiffLoadScheduler
} from './combined-diff-load-scheduler'

// Coalesce repeated rebase writes to the same path into one refetch window.
export const COMBINED_DIFF_SECTION_RELOAD_COALESCE_MS = 300

export function clearPendingSectionReloadTimers(timers: Map<number, number>): void {
  for (const timer of timers.values()) {
    window.clearTimeout(timer)
  }
  timers.clear()
}

// Share loader/retry/revalidation bookkeeping and callback refs that break the loader–retry cycle.
export type CombinedDiffSectionLoadRegistry = {
  generationRef: React.RefObject<number>
  deferredLoadRequestsRef: React.RefObject<Set<number>>
  loadSchedulerRef: React.RefObject<CombinedDiffLoadScheduler>
  loadSectionRef: React.RefObject<(index: number) => Promise<void>>
  loadedIndicesRef: React.RefObject<Set<number>>
  loadingIndicesRef: React.RefObject<Set<number>>
  reloadTimersRef: React.RefObject<Map<number, number>>
  renderedIndicesRef: React.RefObject<Set<number>>
  requestSectionReloadRef: React.RefObject<(index: number) => void>
  /** Re-drives a reload only for a row that refused one while dirty. */
  retryDeferredSectionReloadRef: React.RefObject<(index: number) => void>
  /** Keys whose reload was refused because the row was dirty; keyed by section, not index. */
  deferredReloadKeysRef: React.RefObject<Set<string>>
  /** False once the viewer unmounts, so a late save cannot revive load bookkeeping. */
  registryLiveRef: React.RefObject<boolean>
  retrySectionRef: React.RefObject<(index: number) => void>
  sectionLoadTokensRef: React.RefObject<Map<number, number>>
  sectionsRef: React.RefObject<DiffSection[]>
  supersededLoadIndicesRef: React.RefObject<Set<number>>
}

export function useCombinedDiffSectionLoadRegistry(
  sectionsRef: React.RefObject<DiffSection[]>
): CombinedDiffSectionLoadRegistry {
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const deferredLoadRequestsRef = useRef<Set<number>>(new Set())
  const generationRef = useRef(0)
  // Per-section tokens keep sibling reloads from discarding unrelated in-flight loads.
  const sectionLoadTokensRef = useRef<Map<number, number>>(new Map())
  const renderedIndicesRef = useRef<Set<number>>(new Set())
  const reloadTimersRef = useRef<Map<number, number>>(new Map())
  // After one mid-flight invalidation discards a load, allow the next result to commit.
  const supersededLoadIndicesRef = useRef<Set<number>>(new Set())
  const loadSectionRef = useRef<(index: number) => Promise<void>>(async () => {})
  const retrySectionRef = useRef<(index: number) => void>(() => {})
  const requestSectionReloadRef = useRef<(index: number) => void>(() => {})
  const retryDeferredSectionReloadRef = useRef<(index: number) => void>(() => {})
  const deferredReloadKeysRef = useRef<Set<string>>(new Set())
  const registryLiveRef = useRef(true)
  const loadSchedulerRef = useRef<ReturnType<typeof createCombinedDiffLoadScheduler>>(undefined!)
  loadSchedulerRef.current ??= createCombinedDiffLoadScheduler({
    loadSection: (index) => loadSectionRef.current(index),
    getRenderedIndices: () => renderedIndicesRef.current,
    isSectionExpanded: (index) => sectionsRef.current[index]?.collapsed === false
  })
  // Why in render AND in the effect below: child effects run before this parent's, so a
  // render-only write covers that window; StrictMode replays setup -> cleanup -> setup with no
  // render in between, so an effect-only write is needed to survive the replayed cleanup.
  registryLiveRef.current = true

  useEffect(() => {
    // Reset revives the scheduler after Strict Mode’s cleanup replay.
    const scheduler = loadSchedulerRef.current
    const reloadTimers = reloadTimersRef.current
    scheduler.reset()
    registryLiveRef.current = true
    return () => {
      registryLiveRef.current = false
      clearPendingSectionReloadTimers(reloadTimers)
      scheduler.dispose()
    }
  }, [])

  return {
    generationRef,
    deferredLoadRequestsRef,
    loadSchedulerRef,
    loadSectionRef,
    loadedIndicesRef,
    loadingIndicesRef,
    reloadTimersRef,
    renderedIndicesRef,
    requestSectionReloadRef,
    retryDeferredSectionReloadRef,
    deferredReloadKeysRef,
    registryLiveRef,
    retrySectionRef,
    sectionLoadTokensRef,
    sectionsRef,
    supersededLoadIndicesRef
  }
}
