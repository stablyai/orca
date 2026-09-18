import { isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type FilterAgentIds = TuiAgent[] | null

export function getCatalogTuiAgentIds(): TuiAgent[] {
  return Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]
}

export function normalizeFilterAgentId(value: unknown): TuiAgent | null {
  return isTuiAgent(value) ? value : null
}

export function normalizeFilterAgentIds(value: unknown): FilterAgentIds {
  if (!Array.isArray(value)) {
    return null
  }
  const ids: TuiAgent[] = []
  const seen = new Set<TuiAgent>()
  for (const raw of value) {
    if (!isTuiAgent(raw) || seen.has(raw)) {
      continue
    }
    seen.add(raw)
    ids.push(raw)
  }
  if (ids.length === 0 || ids.length === getCatalogTuiAgentIds().length) {
    return null
  }
  return ids
}

/**
 * Why: a short-lived build persisted `filterHarnessId` as `cc` | `codex`.
 * Those were never TuiAgent ids. Map the leftover values onto catalog agents
 * once, then ignore the old field.
 */
export function migrateLegacyFilterHarnessId(value: unknown): TuiAgent | null {
  if (value === 'codex') {
    return 'codex'
  }
  if (value === 'cc') {
    return 'claude'
  }
  return null
}

export type PersistedAgentFilterFields = {
  filterAgentIds?: unknown
  filterAgentId?: unknown
  filterHarnessId?: unknown
}

/**
 * Why: after the first persist, leftover `filterAgentId` / `filterHarnessId`
 * can still sit on disk. A present `filterAgentIds` (including explicit null)
 * is authoritative.
 */
export function resolvePersistedFilterAgentIds(ui: PersistedAgentFilterFields): FilterAgentIds {
  if (ui.filterAgentIds !== undefined) {
    return normalizeFilterAgentIds(ui.filterAgentIds)
  }
  if (ui.filterAgentId !== undefined) {
    const leftover = normalizeFilterAgentId(ui.filterAgentId)
    return leftover ? [leftover] : null
  }
  const harness = migrateLegacyFilterHarnessId(ui.filterHarnessId)
  return harness ? [harness] : null
}

function incomingUpdatesIncludeLeftoverAgentFilter(
  incoming: Pick<PersistedAgentFilterFields, 'filterAgentId' | 'filterHarnessId'>
): boolean {
  return incoming.filterAgentId !== undefined || incoming.filterHarnessId !== undefined
}

/**
 * Why: older clients write leftover keys without filterAgentIds. Do not merge
 * leftovers into current UI — defaults already set filterAgentIds: null.
 */
export function resolveIncomingFilterAgentIds(params: {
  current: PersistedAgentFilterFields
  incoming: PersistedAgentFilterFields
}): FilterAgentIds {
  if (params.incoming.filterAgentIds !== undefined) {
    return normalizeFilterAgentIds(params.incoming.filterAgentIds)
  }
  if (incomingUpdatesIncludeLeftoverAgentFilter(params.incoming)) {
    return resolvePersistedFilterAgentIds(params.incoming)
  }
  return resolvePersistedFilterAgentIds(params.current)
}

export function collectWorkspaceAgentIds(
  agents: readonly (string | null | undefined)[]
): Set<TuiAgent> {
  const ids = new Set<TuiAgent>()
  for (const agent of agents) {
    if (isTuiAgent(agent)) {
      ids.add(agent)
    }
  }
  return ids
}

/**
 * Empty/cleared selection shows every workspace. A selected catalog set
 * matches when the workspace currently has or last used any of those ids.
 */
export function workspaceMatchesAgentFilter(
  agentIds: ReadonlySet<TuiAgent>,
  selectedAgentIds: FilterAgentIds
): boolean {
  if (selectedAgentIds == null) {
    return true
  }
  return selectedAgentIds.some((id) => agentIds.has(id))
}

/** Host-shaped All toggle: scoped → All; already All → first catalog id. */
export function toggleAllFilterAgents(
  current: FilterAgentIds,
  catalogIds: readonly TuiAgent[]
): FilterAgentIds {
  if (current != null) {
    return null
  }
  const first = catalogIds[0]
  return first ? [first] : null
}

/**
 * Host-shaped item toggle: All → just this id; then multi-select add/remove.
 * The last remaining id cannot be removed. Checking every catalog id → All.
 */
export function toggleFilterAgentId(
  current: FilterAgentIds,
  agentId: TuiAgent,
  catalogIds: readonly TuiAgent[]
): FilterAgentIds {
  if (current == null) {
    return [agentId]
  }
  const next = new Set(current)
  if (next.has(agentId)) {
    if (next.size <= 1) {
      return current
    }
    next.delete(agentId)
  } else {
    next.add(agentId)
  }
  return next.size === catalogIds.length ? null : [...next]
}
