import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { supportsTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import type { TuiAgent } from '../../../../shared/types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

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
  const catalogOrder = new Map<string, number>(catalog.map((entry, index) => [entry.id, index]))

  return [...catalog].sort((a, b) => {
    const aSupported = isTuiAgent(a.id) && supportsTerminalAgentQuickCommand(a.id)
    const bSupported = isTuiAgent(b.id) && supportsTerminalAgentQuickCommand(b.id)
    if (aSupported !== bSupported) {
      return aSupported ? -1 : 1
    }

    const fallbackRank = QUICK_COMMAND_AGENT_PRESENTATION_ORDER.length
    const aRank = isTuiAgent(a.id) ? (QUICK_COMMAND_AGENT_ORDER_RANK.get(a.id) ?? fallbackRank) : fallbackRank
    const bRank = isTuiAgent(b.id) ? (QUICK_COMMAND_AGENT_ORDER_RANK.get(b.id) ?? fallbackRank) : fallbackRank
    if (aRank !== bRank) {
      return aRank - bRank
    }

    return (catalogOrder.get(a.id) ?? 0) - (catalogOrder.get(b.id) ?? 0)
  })
}
