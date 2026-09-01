// Render-time derivation of the default-agent combobox inputs from the local
// catalog snapshot: the enabled option list (built-ins with their enabled customs
// underneath), the current selection value, and a stale/tombstoned current
// default kept for repair. Pure and node-free so it unit-tests without a DOM.

import type { BuiltInTuiAgent, TuiAgent } from '../../../../shared/types'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { buildAgentSearchSummary } from '../../../../shared/agent-search-query'
import type {
  AgentDefaultOption,
  AgentDefaultStale,
  DefaultAgentSelection
} from './AgentDefaultCombobox'

type ReadyCustomEntry = { id: TuiAgent; label: string; baseAgent: BuiltInTuiAgent }

function readyCustomsByBase(
  snapshot: LocalAgentCatalogSnapshot
): Map<BuiltInTuiAgent, ReadyCustomEntry[]> {
  const byBase = new Map<BuiltInTuiAgent, ReadyCustomEntry[]>()
  for (const agent of snapshot.customAgents) {
    if (agent.status !== 'ready') {
      continue
    }
    const base = agent.definition.baseAgent
    const bucket = byBase.get(base) ?? []
    bucket.push({ id: agent.definition.id, label: agent.definition.label, baseAgent: base })
    byBase.set(base, bucket)
  }
  return byBase
}

/** Enabled identities only, built-ins in canonical order with each base's enabled
 *  customs immediately below it (plan §1225). A base-disabled custom is omitted
 *  because its launch is blocked, not merely hidden. */
export function deriveAgentDefaultOptions(
  snapshot: LocalAgentCatalogSnapshot
): AgentDefaultOption[] {
  const disabled = new Set<TuiAgent>(snapshot.disabledAgents)
  const customsByBase = readyCustomsByBase(snapshot)
  const options: AgentDefaultOption[] = []
  for (const entry of getAgentCatalog()) {
    const base = entry.id as BuiltInTuiAgent
    if (!disabled.has(base)) {
      options.push({
        id: base,
        label: entry.label,
        baseAgent: base,
        searchSummary: buildAgentSearchSummary({
          label: entry.label,
          baseName: TUI_AGENT_DISPLAY_NAMES[base],
          commandSummary: entry.cmd
        })
      })
    }
    for (const custom of customsByBase.get(base) ?? []) {
      // A custom whose base is disabled cannot launch, so it is never offerable.
      if (disabled.has(custom.id) || disabled.has(base)) {
        continue
      }
      options.push({
        id: custom.id,
        label: custom.label,
        baseAgent: custom.baseAgent,
        searchSummary: buildAgentSearchSummary({
          label: custom.label,
          baseName: TUI_AGENT_DISPLAY_NAMES[custom.baseAgent]
        })
      })
    }
  }
  return options
}

/** The combobox selection value. A repair-generated `null` default has no
 *  selectable representation and never resolves to Auto at launch, so it yields a
 *  harmless `'auto'` here only as a non-null fallback — the `unset` flag (see
 *  {@link isDefaultUnset}) drives the placeholder trigger and suppresses the check. */
export function deriveDefaultComboboxValue(
  snapshot: LocalAgentCatalogSnapshot
): DefaultAgentSelection {
  const value = snapshot.defaultAgent
  if (value === null || value === 'auto') {
    return 'auto'
  }
  return value
}

/** Repair state: a persistent attention banner, not a selectable value. */
export function isDefaultUnset(snapshot: LocalAgentCatalogSnapshot): boolean {
  return snapshot.defaultAgent === null
}

/** The current default when it is disabled or tombstoned: kept selected with a
 *  warning, but never offered fresh. Resolves the display label/base from the
 *  built-in catalog, a ready/disabled custom, or a tombstone, in that order. */
export function deriveStaleDefault(snapshot: LocalAgentCatalogSnapshot): AgentDefaultStale | null {
  const value = snapshot.defaultAgent
  if (value === null || value === 'auto' || value === 'blank') {
    return null
  }
  const options = deriveAgentDefaultOptions(snapshot)
  if (options.some((option) => option.id === value)) {
    return null
  }
  const builtIn = getAgentCatalog().find((entry) => entry.id === value)
  if (builtIn) {
    return { id: value, label: builtIn.label, baseAgent: builtIn.id as BuiltInTuiAgent }
  }
  const custom = snapshot.customAgents.find(
    (agent) => agent.status === 'ready' && agent.definition.id === value
  )
  if (custom && custom.status === 'ready') {
    return { id: value, label: custom.definition.label, baseAgent: custom.definition.baseAgent }
  }
  // Host normalization keeps a repair-required custom as the stored default when
  // its base is proven; without this branch the trigger falls through to Auto and
  // hides the repair warning. No base is ever derived from id syntax alone.
  const repair = snapshot.customAgents.find(
    (agent) => agent.status === 'repair-required' && agent.id === value
  )
  if (repair && repair.status === 'repair-required' && repair.baseAgent) {
    return {
      id: value,
      label:
        repair.label ??
        translate(
          'auto.components.settings.AgentDefaultCombobox.repairFallbackLabel',
          'Custom agent'
        ),
      baseAgent: repair.baseAgent
    }
  }
  const tombstone = snapshot.deletedCustomAgents.find((agent) => agent.id === value)
  if (tombstone) {
    return { id: value, label: tombstone.label, baseAgent: tombstone.baseAgent }
  }
  return null
}
