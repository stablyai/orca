import {
  customAgentCatalogEntryById,
  mergeCustomAgentCatalogEntries
} from '@/components/agent/custom-agent-catalog-entries'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../../shared/types'

/** Agent options for the automation editor picker: enabled built-ins plus ready
 *  custom agents. Customs are never detection-gated here — automations run later
 *  and headless, so availability is checked at launch (null detection). The
 *  currently-assigned agent is always kept visible with its real label, even when
 *  disabled, so an automation never renders a stale row for its own assignment —
 *  including a custom assignment, which the static built-in draft-keep could not
 *  hold. */
export function buildAutomationAgentOptions(
  draftAgentId: TuiAgent,
  disabledTuiAgents: readonly TuiAgent[] | undefined,
  snapshot: LocalAgentCatalogSnapshot | null
): AgentCatalogEntry[] {
  const disabled = disabledTuiAgents ?? []
  const enabledIds = new Set(
    filterEnabledTuiAgents(
      getAgentCatalog().map((agent) => agent.id),
      disabled
    )
  )
  const builtIns = getAgentCatalog().filter(
    (agent) => enabledIds.has(agent.id) || agent.id === draftAgentId
  )
  const merged = mergeCustomAgentCatalogEntries(builtIns, snapshot, disabled, null)
  if (draftAgentId && !merged.some((entry) => entry.id === draftAgentId)) {
    const kept = customAgentCatalogEntryById(snapshot, draftAgentId)
    if (kept) {
      merged.push(kept)
    }
  }
  return merged
}
