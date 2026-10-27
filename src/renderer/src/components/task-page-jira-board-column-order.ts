import { getEnvironmentRuntimeIdentityKey } from '@/lib/provider-runtime-context'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { TaskPageJiraBoardSection } from './task-page-jira-board-sections'
import type { TaskPageJiraProjectScope } from './task-page-jira-status-order'

// Device-local, like the Jira list columns: Jira's Agile API exposes board column
// order as read-only, so a reorder here is an Orca view preference, not a Jira edit.
const STORAGE_KEY = 'orca.jira.board-column-order.v1'
// Each Jira project reached from this device keeps its own lane order; cap the record
// so a long tail of one-off project scopes cannot grow the key without bound.
const MAX_SCOPES = 20

type StoredOrders = Record<string, string[]>

/**
 * Names one Jira board across launches. The status-order cache key also carries the runtime
 * session generation, which moves on every reconnect and would strand the saved order.
 */
export function getJiraBoardColumnOrderScopeKey(
  sourceContext: TaskSourceContext | null,
  owner: RuntimeClientTarget | null,
  projectScope: TaskPageJiraProjectScope | null
): string {
  return JSON.stringify([
    sourceContext ? getTaskSourceCacheScope(sourceContext) : null,
    owner ? getEnvironmentRuntimeIdentityKey(runtimeTargetEnvironmentId(owner)) : null,
    projectScope?.key ?? null
  ])
}

function readStoredOrders(): StoredOrders {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const orders: StoredOrders = {}
    for (const [scopeKey, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys)) {
        orders[scopeKey] = keys.filter((key): key is string => typeof key === 'string')
      }
    }
    return orders
  } catch {
    return {}
  }
}

export function loadJiraBoardColumnOrder(scopeKey: string): string[] {
  return readStoredOrders()[scopeKey] ?? []
}

export function saveJiraBoardColumnOrder(scopeKey: string, keys: readonly string[]): void {
  try {
    const { [scopeKey]: _previous, ...others } = readStoredOrders()
    // Re-inserting last makes the record's own key order a least-recently-used list.
    const entries = Object.entries(others).slice(-(MAX_SCOPES - 1))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...Object.fromEntries(entries), [scopeKey]: [...keys] })
    )
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

/**
 * Sorts sections by a saved lane order. A column the saved order has never seen,
 * such as one added in Jira since, stays next to the neighbour Jira put it after.
 */
export function applyJiraBoardColumnOrder(
  sections: readonly TaskPageJiraBoardSection[],
  order: readonly string[]
): TaskPageJiraBoardSection[] {
  if (order.length === 0) {
    return [...sections]
  }
  const ranks = new Map(order.map((key, index) => [key, index]))
  let previousRank = -1
  const ranked = sections.map((section, index) => {
    const saved = ranks.get(section.key)
    if (saved !== undefined) {
      previousRank = saved
      return { section, rank: saved, unsaved: 0, index }
    }
    return { section, rank: previousRank, unsaved: 1, index }
  })
  return ranked
    .sort((a, b) => a.rank - b.rank || a.unsaved - b.unsaved || a.index - b.index)
    .map((entry) => entry.section)
}

/**
 * Folds a new visible lane order back into the saved one. A filter or search can hide a
 * lane entirely, and saving only what is on screen would drop that lane's saved position;
 * each hidden lane stays behind the visible lane it already followed.
 */
export function mergeJiraBoardColumnOrder(
  saved: readonly string[],
  visible: readonly string[]
): string[] {
  const visibleKeys = new Set(visible)
  const hiddenAfter = new Map<string | null, string[]>()
  let anchor: string | null = null
  for (const key of saved) {
    if (visibleKeys.has(key)) {
      anchor = key
      continue
    }
    hiddenAfter.set(anchor, [...(hiddenAfter.get(anchor) ?? []), key])
  }
  const merged = [...(hiddenAfter.get(null) ?? [])]
  for (const key of visible) {
    merged.push(key, ...(hiddenAfter.get(key) ?? []))
  }
  return merged
}

/** Returns the full lane order with `movedKey` placed where `targetKey` sits. */
export function moveJiraBoardColumn(
  keys: readonly string[],
  movedKey: string,
  targetKey: string
): string[] {
  const from = keys.indexOf(movedKey)
  const to = keys.indexOf(targetKey)
  if (from === -1 || to === -1 || from === to) {
    return [...keys]
  }
  const next = [...keys]
  next.splice(from, 1)
  next.splice(to, 0, movedKey)
  return next
}
