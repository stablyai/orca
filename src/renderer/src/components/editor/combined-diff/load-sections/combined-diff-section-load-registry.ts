import { useEffect, useRef } from 'react'
import type { DiffSection } from '../../diff-section-types'
import {
  createCombinedDiffLoadScheduler,
  type CombinedDiffLoadScheduler
} from './combined-diff-load-scheduler'

// Why: git rewrites a path several times during a rebase; refetch once the writes stop.
export const COMBINED_DIFF_SECTION_RELOAD_COALESCE_MS = 300

export function clearPendingSectionReloadTimers(timers: Map<number, number>): void {
  for (const timer of timers.values()) {
    window.clearTimeout(timer)
  }
  timers.clear()
}

// Why: one owner for the load bookkeeping the loader, retry and revalidation hooks all mutate,
// and for the callback refs that break the loader <-> retry cycle.
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
}

export function useCombinedDiffSectionLoadRegistry(
  sectionsRef: React.RefObject<DiffSection[]>
): CombinedDiffSectionLoadRegistry {
  const loadedIndicesRef = useRef<Set<number>>(new Set())
  const loadingIndicesRef = useRef<Set<number>>(new Set())
  const deferredLoadRequestsRef = useRef<Set<number>>(new Set())
  const generationRef = useRef(0)
  // Why: per-section reload token, so a sibling's reload can't discard this section's in-flight load.
  const sectionLoadTokensRef = useRef<Map<number, number>>(new Map())
  const renderedIndicesRef = useRef<Set<number>>(new Set())
  const reloadTimersRef = useRef<Map<number, number>>(new Map())
  const loadSectionRef = useRef<(index: number) => Promise<void>>(async () => {})
  const retrySectionRef = useRef<(index: number) => void>(() => {})
  const requestSectionReloadRef = useRef<(index: number) => void>(() => {})
  const retryDeferredSectionReloadRef = useRef<(index: number) => void>(() => {})
  const deferredReloadKeysRef = useRef<Set<string>>(new Set())
  const registryLiveRef = useRef(true)
  const loadSchedulerRef = useRef<ReturnType<typeof createCombinedDiffLoadScheduler>>(undefined!)
  loadSchedulerRef.current ??= createCombinedDiffLoadScheduler({
    loadSection: (index) => loadSectionRef.current(index)
  })
  // Why here and not in the effect below: child effects run before this parent's, so StrictMode's
  // replayed mount would leave a window where the ref reads false while the viewer is live.
  registryLiveRef.current = true

  useEffect(() => {
    // Why: React StrictMode replays effect cleanup in dev; reset revives the scheduler for the replayed mount.
    const scheduler = loadSchedulerRef.current
    const reloadTimers = reloadTimersRef.current
    scheduler.reset()
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
    sectionsRef
  }
}
