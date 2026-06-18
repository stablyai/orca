import { getAgentCatalog } from '@/lib/agent-catalog'
import { normalizeAgentLaunchProfiles } from '../../../../shared/agent-launch-profiles'
import type { AgentLaunchProfile, TuiAgent } from '../../../../shared/types'

export type TabAgentLaunchOption = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
  menuLabel: string
  profileId?: string
}

export type TabAgentLaunchGroup = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
  options: readonly TabAgentLaunchOption[]
}

function normalizeAgentAlias(value: string): string {
  return value.trim().toLowerCase()
}

function compactAgentAlias(value: string): string {
  return normalizeAgentAlias(value).replace(/[\s_-]+/g, '')
}

function getCatalogEntry(agent: TuiAgent): { id: TuiAgent; label: string; cmd: string } | null {
  return getAgentCatalog().find((entry) => entry.id === agent) ?? null
}

export function orderTabLaunchAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[]
): TuiAgent[] {
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => detected.includes(entry.id))
    .map((entry) => entry.id)
  if (!defaultAgent || defaultAgent === 'blank' || !inCatalogOrder.includes(defaultAgent)) {
    return inCatalogOrder
  }
  return [defaultAgent, ...inCatalogOrder.filter((id) => id !== defaultAgent)]
}

export function buildTabAgentLaunchOptions(
  agents: readonly TuiAgent[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {},
  profiles: readonly AgentLaunchProfile[] = []
): TabAgentLaunchOption[] {
  return buildTabAgentLaunchGroups(agents, commandOverrides, profiles).flatMap(
    (group) => group.options
  )
}

export function buildTabAgentLaunchGroups(
  agents: readonly TuiAgent[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {},
  profiles: readonly AgentLaunchProfile[] = []
): TabAgentLaunchGroup[] {
  const normalizedProfiles = normalizeAgentLaunchProfiles(profiles).filter(
    (profile) => !profile.disabled
  )
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
    const baseOption: TabAgentLaunchOption = {
      agent,
      aliases: [...aliases],
      label,
      menuLabel: label
    }
    const profileOptions = normalizedProfiles
      .filter((profile) => profile.agentId === agent)
      .map((profile): TabAgentLaunchOption => {
        const profileLabel = `${label}: ${profile.name}`
        const profileAliases = new Set<string>([
          normalizeAgentAlias(profile.id),
          compactAgentAlias(profile.id),
          normalizeAgentAlias(profile.name),
          compactAgentAlias(profile.name),
          normalizeAgentAlias(profileLabel),
          compactAgentAlias(profileLabel),
          normalizeAgentAlias(`${label} ${profile.name}`),
          compactAgentAlias(`${label} ${profile.name}`)
        ])
        const profileCommandOverride = profile.commandOverride?.trim() || commandOverride
        if (profileCommandOverride) {
          profileAliases.add(normalizeAgentAlias(profileCommandOverride))
          profileAliases.add(compactAgentAlias(profileCommandOverride))
        }
        const profileArgs = profile.args?.trim()
        if (profileArgs) {
          profileAliases.add(normalizeAgentAlias(profileArgs))
          profileAliases.add(compactAgentAlias(profileArgs))
          profileAliases.add(normalizeAgentAlias(`${label} ${profileArgs}`))
          profileAliases.add(compactAgentAlias(`${label} ${profileArgs}`))
        }
        return {
          agent,
          profileId: profile.id,
          aliases: [...profileAliases],
          label: profileLabel,
          menuLabel: profile.name
        }
      })
    return {
      agent,
      aliases: [...aliases],
      label,
      options: [baseOption, ...profileOptions]
    }
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
