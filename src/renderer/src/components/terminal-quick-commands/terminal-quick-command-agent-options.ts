import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  customAgentCatalogEntryById,
  mergeCustomAgentCatalogEntries
} from '@/components/agent/custom-agent-catalog-entries'
import { supportsTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import type { TuiAgent } from '../../../../shared/types'

const QUICK_COMMAND_AGENT_PRESENTATION_ORDER = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'opencode',
  'pi',
  'omp',
  'cursor',
  'droid',
  'command-code',
  'openclaude'
] as const satisfies readonly TuiAgent[]

const QUICK_COMMAND_AGENT_ORDER_RANK = new Map<TuiAgent, number>(
  QUICK_COMMAND_AGENT_PRESENTATION_ORDER.map((agent, index) => [agent, index])
)

export function getTerminalQuickCommandAgentOptions(
  catalog: readonly AgentCatalogEntry[] = getAgentCatalog()
): AgentCatalogEntry[] {
  const catalogOrder = new Map<TuiAgent, number>(catalog.map((entry, index) => [entry.id, index]))

  return [...catalog].sort((a, b) => {
    const aSupported = supportsTerminalAgentQuickCommand(a.id)
    const bSupported = supportsTerminalAgentQuickCommand(b.id)
    if (aSupported !== bSupported) {
      return aSupported ? -1 : 1
    }

    const fallbackRank = QUICK_COMMAND_AGENT_PRESENTATION_ORDER.length
    const aRank = QUICK_COMMAND_AGENT_ORDER_RANK.get(a.id) ?? fallbackRank
    const bRank = QUICK_COMMAND_AGENT_ORDER_RANK.get(b.id) ?? fallbackRank
    if (aRank !== bRank) {
      return aRank - bRank
    }

    return (catalogOrder.get(a.id) ?? 0) - (catalogOrder.get(b.id) ?? 0)
  })
}

/** Quick-command picker options including ready custom agents. Quick commands are
 *  a custom-reference owner, so customs must be selectable; base capability is
 *  validated at launch, so customs are never detection-gated (null detection).
 *  The currently-selected agent is kept visible by its real label even when
 *  disabled, so an existing command never renders an empty picker for its own
 *  custom agent. */
export function buildTerminalQuickCommandAgentOptions(
  selectedAgent: TuiAgent | null,
  disabledTuiAgents: readonly TuiAgent[] | undefined,
  snapshot: LocalAgentCatalogSnapshot | null
): AgentCatalogEntry[] {
  const disabled = disabledTuiAgents ?? []
  const options = getTerminalQuickCommandAgentOptions(
    mergeCustomAgentCatalogEntries(getAgentCatalog(), snapshot, disabled, null)
  )
  if (selectedAgent && !options.some((entry) => entry.id === selectedAgent)) {
    const kept = customAgentCatalogEntryById(snapshot, selectedAgent)
    if (kept) {
      options.push(kept)
    }
  }
  return options
}
