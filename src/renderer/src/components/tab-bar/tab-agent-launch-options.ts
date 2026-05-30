import { AGENT_CATALOG, buildAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog'
import type { CustomTuiAgent, TuiAgentId } from '../../../../shared/types'

export type TabAgentLaunchOption = {
  agent: TuiAgentId
  aliases: readonly string[]
  label: string
}

function normalizeAgentAlias(value: string): string {
  return value.trim().toLowerCase()
}

function compactAgentAlias(value: string): string {
  return normalizeAgentAlias(value).replace(/[\s_-]+/g, '')
}

function getCatalogEntry(
  agent: TuiAgentId,
  catalog: readonly AgentCatalogEntry[]
): AgentCatalogEntry | null {
  return catalog.find((entry) => entry.id === agent) ?? null
}

export function orderTabLaunchAgents(
  defaultAgent: TuiAgentId | 'blank' | null | undefined,
  detected: readonly TuiAgentId[],
  customAgents: readonly CustomTuiAgent[] = []
): TuiAgentId[] {
  const detectedSet = new Set(detected)
  const builtInOrder = AGENT_CATALOG.filter((entry) => detectedSet.has(entry.id)).map(
    (entry) => entry.id
  )
  // Why: custom presets can wrap absolute paths or aliases that agent detection
  // cannot discover; the manual launch surfaces should still expose them.
  const readyCustoms = customAgents
    .filter((agent) => agent.command.trim().length > 0)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((agent) => agent.id)
  const inCatalogOrder = [...builtInOrder, ...readyCustoms]
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function buildTabAgentLaunchOptions(
  agents: readonly TuiAgentId[],
  commandOverrides: Partial<Record<TuiAgentId, string>> = {},
  customAgents: readonly CustomTuiAgent[] = []
): TabAgentLaunchOption[] {
  const catalog = buildAgentCatalog(customAgents)
  return agents.map((agent) => {
    const entry = getCatalogEntry(agent, catalog)
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
