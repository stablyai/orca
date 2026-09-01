import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { deriveTabCustomAgentEntries } from '@/components/tab-bar/tab-agent-launch-options'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../../shared/types'

/** Merges ready, enabled custom agents into a built-in AgentCatalogEntry list for
 *  the shared pickers (composer, automation editor), grouped directly under their
 *  base harness like the settings catalog and the tab quick-launch surfaces.
 *
 *  Oracle 35 gating: a baseline-stock custom is offered only when its base is
 *  detected; a configured-executable/custom-PATH custom is launch-reported at
 *  launch and never client-gated. A null `detectedAgentIds` means detection is
 *  unknown, so nothing is detection-gated (mirrors the built-in list). Adapted
 *  rows carry the base harness id so AgentCombobox renders the base icon, and
 *  label + command come from the custom's own definition — never the raw id. */
export function mergeCustomAgentCatalogEntries(
  builtIns: readonly AgentCatalogEntry[],
  snapshot: LocalAgentCatalogSnapshot | null,
  disabledTuiAgents: readonly TuiAgent[],
  detectedAgentIds: ReadonlySet<TuiAgent> | null
): AgentCatalogEntry[] {
  const customs = deriveTabCustomAgentEntries(snapshot, disabledTuiAgents).filter(
    (custom) =>
      !custom.requiresDetectedBase ||
      detectedAgentIds === null ||
      detectedAgentIds.has(custom.baseAgent)
  )
  if (customs.length === 0) {
    return [...builtIns]
  }
  const catalogById = new Map(getAgentCatalog().map((entry) => [entry.id, entry]))
  const customsByBase = new Map<TuiAgent, AgentCatalogEntry[]>()
  for (const custom of customs) {
    const base = catalogById.get(custom.baseAgent)
    const adapted: AgentCatalogEntry = {
      id: custom.id,
      label: custom.label,
      cmd: custom.commandOverride ?? base?.cmd ?? custom.baseAgent,
      homepageUrl: base?.homepageUrl ?? '',
      baseAgent: custom.baseAgent
    }
    const group = customsByBase.get(custom.baseAgent)
    if (group) {
      group.push(adapted)
    } else {
      customsByBase.set(custom.baseAgent, [adapted])
    }
  }
  const merged: AgentCatalogEntry[] = []
  const placed = new Set<TuiAgent>()
  for (const entry of builtIns) {
    merged.push(entry)
    const group = customsByBase.get(entry.id)
    if (group) {
      merged.push(...group)
      placed.add(entry.id)
    }
  }
  // A launch-reported custom whose base row was filtered out (base disabled or
  // undetected) is still launch-eligible, so append it rather than drop it.
  for (const [base, group] of customsByBase) {
    if (!placed.has(base)) {
      merged.push(...group)
    }
  }
  return merged
}

/** Adapts a single ready custom row to a picker entry by id, ignoring enabled and
 *  detection state. For a draft-keep: a surface whose stored selection is a custom
 *  (an automation, a quick command) shows the custom's real label instead of a
 *  stale row, even when the custom is disabled. Returns null for an unknown id or a
 *  repair-required row (no safe label to display). */
export function customAgentCatalogEntryById(
  snapshot: LocalAgentCatalogSnapshot | null,
  id: TuiAgent
): AgentCatalogEntry | null {
  const row = snapshot?.customAgents.find(
    (candidate) => candidate.status === 'ready' && candidate.definition.id === id
  )
  if (!row || row.status !== 'ready') {
    return null
  }
  const base = getAgentCatalog().find((entry) => entry.id === row.definition.baseAgent)
  return {
    id: row.definition.id,
    label: row.definition.label,
    cmd: row.definition.commandOverride?.trim() || base?.cmd || row.definition.baseAgent,
    homepageUrl: base?.homepageUrl ?? '',
    baseAgent: row.definition.baseAgent
  }
}
