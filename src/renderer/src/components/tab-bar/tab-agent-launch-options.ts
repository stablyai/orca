import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../shared/types'

export type TabAgentLaunchOption = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
}

function normalizeAgentAlias(value: string): string {
  return value.trim().toLowerCase()
}

function compactAgentAlias(value: string): string {
  return normalizeAgentAlias(value).replace(/[\s_-]+/g, '')
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string; cmd: string } | null {
  return AGENT_CATALOG.find((entry) => entry.id === agent) ?? null
}

export function orderTabLaunchAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = AGENT_CATALOG.filter((entry) => detected.includes(entry.id)).map(
    (entry) => entry.id
  )
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function buildTabAgentLaunchOptions(
  agents: readonly TuiAgent[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {}
): TabAgentLaunchOption[] {
  return agents.map((agent) => {
    const entry = getCatalogEntry(agent)
    const label = entry?.label ?? agent
    const aliases = new Set<string>([
      normalizeAgentAlias(agent),
      normalizeAgentAlias(label),
      compactAgentAlias(agent),
      compactAgentAlias(label)
    ])
    if (entry?.cmd) {
      aliases.add(normalizeAgentAlias(entry.cmd))
      aliases.add(compactAgentAlias(entry.cmd))
    }
    const commandOverride = commandOverrides[agent]?.trim()
    if (commandOverride) {
      aliases.add(normalizeAgentAlias(commandOverride))
      aliases.add(compactAgentAlias(commandOverride))
    }
    return { agent, aliases: [...aliases], label }
  })
}

export function findMatchingTabAgentLaunchOptions(
  query: string,
  agents: readonly TabAgentLaunchOption[]
): TabAgentLaunchOption[] {
  const normalizedQuery = normalizeAgentAlias(query)
  if (!normalizedQuery) {
    return []
  }
  const compactQuery = compactAgentAlias(query)
  return agents.filter(
    (option) => option.aliases.includes(normalizedQuery) || option.aliases.includes(compactQuery)
  )
}
