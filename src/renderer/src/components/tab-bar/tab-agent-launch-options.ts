import { rowLabel, rowId, chatUnavailableLabel } from './tab-agent-row-presentation'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { normalizeMatchQuery, tokenizeMatchValue } from './query-token-match'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { NewTabAgentMenuRow } from '@/lib/new-tab-agent-menu-rows'

export type TabAgentLaunchOption = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
  disabled?: boolean
  id?: string
  row?: NewTabAgentMenuRow
  reason?: string
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
  detected: readonly TuiAgent[],
  disabled?: Iterable<unknown> | null
): TuiAgent[] {
  const enabledDetected = filterEnabledTuiAgents(detected, disabled)
  const inCatalogOrder = getAgentCatalog()
    .filter((entry) => enabledDetected.includes(entry.id))
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
    return {
      agent,
      aliases: [...aliases],
      label
    }
  })
}

export function buildTabAgentLaunchOptionsFromRows(
  rows: readonly NewTabAgentMenuRow[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {}
): TabAgentLaunchOption[] {
  return rows.map((row) => {
    const base = buildTabAgentLaunchOptions([row.agent], commandOverrides)[0]
    return {
      ...base,
      agent: row.agent,
      aliases: base?.aliases ?? [],
      label: rowLabel(row),
      disabled: row.kind === 'chat-unavailable',
      reason: row.kind === 'chat-unavailable' ? chatUnavailableLabel(row.reason) : undefined,
      row,
      id: row.kind === 'terminal' ? `agent:${row.agent}` : rowId(row)
    }
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
  return (
    agents
      .map((option, index) => ({
        index,
        option,
        score: scoreAgentLaunchOption(normalizedQuery, compactQuery, option)
      }))
      .filter((entry) => entry.score > 0)
      // Why: the first match takes Enter, so a row that can't launch never outranks one that can.
      .sort(
        (left, right) =>
          Number(Boolean(left.option.disabled)) - Number(Boolean(right.option.disabled)) ||
          right.score - left.score ||
          left.index - right.index
      )
      .map((entry) => entry.option)
  )
}
