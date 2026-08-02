import { getAgentCatalog } from '@/lib/agent-catalog'
import { normalizeMatchQuery, tokenizeMatchValue } from './query-token-match'
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

// Scores how well a query matches an agent. Exact alias equality is the
// strongest signal; otherwise every query token must prefix some alias token.
// Why prefix-only (not substring): agent rows rank above file matches, so a
// mid-string match like "ode" → "opencode" would noisily hijack the list.
function scoreAgentLaunchOption(
  normalizedQuery: string,
  compactQuery: string,
  option: TabAgentLaunchOption
): number {
  if (option.aliases.includes(normalizedQuery) || option.aliases.includes(compactQuery)) {
    return 1000
  }
  const candidateTokens = option.aliases.flatMap(tokenizeMatchValue)
  const queryTokens = tokenizeMatchValue(normalizedQuery)
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0
  }
  let score = 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) {
        best = Math.max(best, 3)
      } else if (queryToken.length >= 2 && candidateToken.startsWith(queryToken)) {
        // Why: a single-character prefix matches almost every agent, flooding the
        // list and letting one keystroke auto-launch the wrong agent; require an
        // exact token match below 2 chars.
        best = Math.max(best, 2)
      }
    }
    if (best === 0) {
      return 0
    }
    score += best
  }
  return score
}

export function findMatchingTabAgentLaunchOptions(
  query: string,
  agents: readonly TabAgentLaunchOption[]
): TabAgentLaunchOption[] {
  const normalizedQuery = normalizeMatchQuery(query)
  if (!normalizedQuery) {
    return []
  }
  const compactQuery = compactAgentAlias(query)
  return agents
    .map((option, index) => ({
      index,
      option,
      score: scoreAgentLaunchOption(normalizedQuery, compactQuery, option)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      left.score !== right.score ? right.score - left.score : left.index - right.index
    )
    .map((entry) => entry.option)
}
