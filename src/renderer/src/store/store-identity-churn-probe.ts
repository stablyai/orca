/**
 * Counts store writes that hand out a NEW reference for a field whose value did
 * not change — the write-side half of Zustand rerender churn.
 *
 * Why a runtime probe and not a lint rule: the read side is statically decidable
 * (app-store-performance flags selectors that allocate), but whether a `set()`
 * reallocated for nothing depends on the payload, so only an executed write can
 * answer it. A field that churns re-renders every component selecting it, with
 * no data change to show for it.
 *
 * Cost when disarmed: one boolean field load per write, matching
 * react-commit-cascade-write-probe. Comparison work only happens while armed,
 * so this never sits on the keystroke path in a shipped build.
 */
import type { StateCreator } from 'zustand'

export const storeIdentityChurnProbe = { armed: false, captureSites: false }

export type StoreIdentityChurnRow = {
  field: string
  /** Writes that replaced the reference while the value stayed equal. */
  churnedWrites: number
  /** Writes that replaced the reference at all. */
  replacedWrites: number
  /** Write sites that churned, worst first; empty unless capture was requested. */
  sites: { site: string; churnedWrites: number }[]
}

// Why bounded: an unbounded deep compare over a fully populated store would
// dominate the measurement it is trying to take.
const NODE_BUDGET = 20_000
const MAX_DEPTH = 12

type CompareBudget = { nodesLeft: number }

// Why plain-only: Map/Set/Date/class instances expose no own enumerable keys, so a
// key-wise compare would call two different instances equal.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Value equality with a node budget; an exhausted budget reports "changed". */
function valuesEqual(left: unknown, right: unknown, depth: number, budget: CompareBudget): boolean {
  if (Object.is(left, right)) {
    return true
  }
  budget.nodesLeft -= 1
  if (budget.nodesLeft <= 0 || depth > MAX_DEPTH) {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((entry, index) => valuesEqual(entry, right[index], depth + 1, budget))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false
  }
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) {
    return false
  }
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && valuesEqual(left[key], right[key], depth + 1, budget)
  )
}

const churnedWritesByField = new Map<string, number>()
const replacedWritesByField = new Map<string, number>()
const churnedWritesByFieldSite = new Map<string, Map<string, number>>()

function increment(counts: Map<string, number>, field: string): void {
  counts.set(field, (counts.get(field) ?? 0) + 1)
}

export function armStoreIdentityChurnProbe(options?: { captureSites?: boolean }): void {
  churnedWritesByField.clear()
  replacedWritesByField.clear()
  churnedWritesByFieldSite.clear()
  storeIdentityChurnProbe.captureSites = options?.captureSites === true
  storeIdentityChurnProbe.armed = true
}

// Why the first non-probe, non-zustand frame: the caller that built the partial is
// the code to fix; the frames above it are the shared write plumbing.
const SOURCE_FRAME = /:\d+:\d+\)?$/

function callingSite(): string {
  const stack = new Error('store identity churn site').stack?.split('\n') ?? []
  for (const line of stack.slice(2)) {
    const frame = line.trim()
    if (
      SOURCE_FRAME.test(frame) &&
      !frame.includes('store-identity-churn-probe.ts') &&
      !frame.includes('node_modules')
    ) {
      return frame
    }
  }
  return 'unknown'
}

export function disarmStoreIdentityChurnProbe(): void {
  storeIdentityChurnProbe.armed = false
}

/** Fields that churned at least once, worst first. */
export function readStoreIdentityChurnReport(): StoreIdentityChurnRow[] {
  return [...churnedWritesByField.entries()]
    .map(([field, churnedWrites]) => ({
      field,
      churnedWrites,
      replacedWrites: replacedWritesByField.get(field) ?? 0,
      sites: [...(churnedWritesByFieldSite.get(field)?.entries() ?? [])]
        .map(([site, count]) => ({ site, churnedWrites: count }))
        .sort((left, right) => right.churnedWrites - left.churnedWrites)
    }))
    .sort((left, right) => right.churnedWrites - left.churnedWrites)
}

function recordSite(field: string): void {
  const site = callingSite()
  let sites = churnedWritesByFieldSite.get(field)
  if (!sites) {
    sites = new Map()
    churnedWritesByFieldSite.set(field, sites)
  }
  sites.set(site, (sites.get(site) ?? 0) + 1)
}

/**
 * `fields` is the write's own keys, not the whole state: `set(partial)` merges, so
 * no field outside the partial can have changed. Scanning the full post-write state
 * would make the armed cost scale with the store's field count instead of the
 * write's size.
 */
function recordWrite(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  fields: readonly string[]
): void {
  const budget: CompareBudget = { nodesLeft: NODE_BUDGET }
  for (const field of fields) {
    const before = previous[field]
    const after = next[field]
    if (Object.is(before, after)) {
      continue
    }
    increment(replacedWritesByField, field)
    // Primitives cannot churn: a different primitive is a real change.
    if (typeof after !== 'object' || after === null) {
      continue
    }
    if (valuesEqual(before, after, 0, budget)) {
      increment(churnedWritesByField, field)
      if (storeIdentityChurnProbe.captureSites) {
        recordSite(field)
      }
    }
  }
}

/**
 * Wraps the state creator rather than patching setState, for the same reason as
 * react-commit-cascade-write-probe: slices capture the `set` closure built before
 * `api` exists, and slice-internal writes are the ones that churn.
 */
export function withStoreIdentityChurnProbe<TState>(
  createState: StateCreator<TState, [], []>
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const wrapped = ((partial: unknown, replace?: unknown): void => {
      if (!storeIdentityChurnProbe.armed) {
        ;(set as (nextPartial: unknown, nextReplace?: unknown) => void)(partial, replace)
        return
      }
      const previous = get() as Record<string, unknown>
      // Why resolve the updater here: zustand would otherwise compute the partial
      // internally and the probe could only recover the changed fields by scanning
      // the whole state. Same function, same argument, called once.
      const resolved =
        typeof partial === 'function'
          ? (partial as (state: Record<string, unknown>) => unknown)(previous)
          : partial
      ;(set as (nextPartial: unknown, nextReplace?: unknown) => void)(resolved, replace)
      try {
        const next = get() as Record<string, unknown>
        // A replace write drops absent fields, so every field is in play.
        const fields =
          replace === true || resolved === null || typeof resolved !== 'object'
            ? Object.keys(next)
            : Object.keys(resolved as Record<string, unknown>)
        recordWrite(previous, next, fields)
      } catch {
        // A diagnostic on the app's universal write path must never break writes.
      }
    }) as typeof set
    api.setState = wrapped as typeof api.setState
    return createState(wrapped, get, api)
  }
}
