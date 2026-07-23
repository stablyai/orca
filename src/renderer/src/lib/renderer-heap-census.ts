import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import { useAppStore } from '@/store'

// Why: production renderer OOMs report the heap pegged at the V8 ceiling but the
// crash bundle only carries heap *totals*, never an object breakdown — so a leak
// can be proven yet impossible to attribute (see crash-diagnostics.ts sampler).
// This takes a cheap, privacy-safe census (entry COUNTS only, never contents) of
// the renderer's long-lived collections when the heap is near its limit, so the
// next OOM report names the collection that grew instead of guessing.
//
// Scope: store collections + ATTACHED DOM node count. It does NOT see detached
// DOM, closures, or non-store JS objects — for those it narrows the field (rules
// store maps in/out, flags attached-DOM growth) rather than naming the leak; a
// full heap snapshot would be needed to attribute those, at PII/size/perf cost.

/** Only surface collections at least this large — at high-water the leaking
 *  collection is big, and small/steady maps would just be noise. */
export const HEAP_CENSUS_MIN_COLLECTION_SIZE = 100

/** Cap the reported collections so one census can't bloat the breadcrumb buffer
 *  it is meant to diagnose; the largest are the ones worth naming. */
export const HEAP_CENSUS_MAX_COLLECTIONS = 20

function collectionSize(value: unknown): number | null {
  if (value instanceof Map || value instanceof Set) {
    return value.size
  }
  if (Array.isArray(value)) {
    return value.length
  }
  // Plain record used as a keyed map (the store's `${x}By${Y}` shape). Exclude
  // class instances / null-proto objects so we count only data collections.
  if (value !== null && typeof value === 'object' && isPlainRecord(value)) {
    return Object.keys(value).length
  }
  return null
}

function isPlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Build the census from an already-captured store state + DOM node count. Pure
 * and deterministic so it is unit-testable without a live renderer.
 */
export function censusFromStoreState(
  state: Record<string, unknown>,
  domNodeCount: number
): CrashReportBreadcrumbData {
  const sized: { key: string; size: number }[] = []
  let collectionsTotalEntries = 0

  for (const [key, value] of Object.entries(state)) {
    const size = collectionSize(value)
    if (size === null) {
      continue
    }
    collectionsTotalEntries += size
    if (size >= HEAP_CENSUS_MIN_COLLECTION_SIZE) {
      sized.push({ key, size })
    }
  }

  sized.sort((a, b) => b.size - a.size)

  const census: CrashReportBreadcrumbData = {
    domNodes: domNodeCount,
    storeCollectionsTotalEntries: collectionsTotalEntries
  }
  for (const { key, size } of sized.slice(0, HEAP_CENSUS_MAX_COLLECTIONS)) {
    census[`store.${key}`] = size
  }
  return census
}

/** Live-renderer entry point: snapshot the store + DOM and build the census.
 *  crash-diagnostics.ts imports this module dynamically (only at a high-water
 *  sample), so the store dependency stays off its hot import chain. */
export function collectRendererHeapCensus(): CrashReportBreadcrumbData {
  const state = useAppStore.getState() as unknown as Record<string, unknown>
  const domNodeCount =
    typeof document !== 'undefined' ? document.getElementsByTagName('*').length : 0
  return censusFromStoreState(state, domNodeCount)
}
