// Per-row render paths (worktree cards, kanban cards, map nodes, AgentIcon)
// resolve a pane's custom-agent label/base on every render, and the settings
// store publishes plain arrays — so each lookup was a linear scan, O(rows ×
// catalog) per render pass. These by-id indexes are memoized on the array
// identity the store publishes: a catalog edit swaps the array and rebuilds the
// index once; every render-path lookup is O(1). Mutating a published array in
// place is not supported (the store always replaces it).

import type {
  BuiltInTuiAgent,
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent
} from '../../../shared/types'
import { isBuiltInTuiAgent } from '../../../shared/tui-agent-config'
import type { AgentCatalogSettings } from './agent-catalog-settings-source'

type CatalogRow = { id?: unknown }

const indexCache = new WeakMap<readonly unknown[], ReadonlyMap<string, CatalogRow>>()

/** First-wins by-id index (parity with `.find` on a duplicate id), skipping the
 *  null-ish rows the scan-based lookups also tolerated. */
function byId<T extends CatalogRow>(
  rows: readonly (T | null | undefined)[] | null | undefined
): ReadonlyMap<string, T> | null {
  if (!rows) {
    return null
  }
  const cached = indexCache.get(rows)
  if (cached) {
    return cached as ReadonlyMap<string, T>
  }
  const index = new Map<string, T>()
  for (const row of rows) {
    if (row && typeof row.id === 'string' && !index.has(row.id)) {
      index.set(row.id, row)
    }
  }
  indexCache.set(rows, index)
  return index
}

/** The custom agent's own name — live definition first, then tombstone — or
 *  null when the catalog cannot name the id. Untrimmed, like the scans it
 *  replaces; callers keep their `trim() || fallback`. */
export function customAgentSettingsLabel(
  settings: AgentCatalogSettings | null | undefined,
  id: CustomTuiAgentId
): string | null {
  return (
    byId(settings?.customTuiAgents)?.get(id)?.label ??
    byId(settings?.deletedCustomTuiAgents)?.get(id)?.label ??
    null
  )
}

/** Catalog-proven base harness of a custom id (live first, then tombstone),
 *  matching `resolveTuiAgentBaseAgent`'s custom branch: a row whose base is not
 *  a built-in never resolves, and an unknown id is null — never a base derived
 *  from id syntax. */
export function customAgentSettingsBase(
  settings: AgentCatalogSettings | null | undefined,
  id: CustomTuiAgentId
): BuiltInTuiAgent | null {
  const live = byId<CustomTuiAgent>(settings?.customTuiAgents)?.get(id)
  if (live && isBuiltInTuiAgent(live.baseAgent)) {
    return live.baseAgent
  }
  const tombstone = byId<DeletedCustomTuiAgent>(settings?.deletedCustomTuiAgents)?.get(id)
  if (tombstone && isBuiltInTuiAgent(tombstone.baseAgent)) {
    return tombstone.baseAgent
  }
  return null
}
