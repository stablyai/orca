import { getAgentCatalog } from '@/lib/agent-catalog'
import { normalizeMatchQuery, tokenizeMatchValue } from './query-token-match'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type { BuiltInTuiAgent, CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'

export type TabAgentLaunchOption = {
  agent: TuiAgent
  aliases: readonly string[]
  label: string
  /** Set for custom agents so rows render the base harness icon. */
  baseAgent?: BuiltInTuiAgent
}

export type TabCustomAgentLaunchEntry = {
  id: CustomTuiAgentId
  baseAgent: BuiltInTuiAgent
  label: string
  commandOverride?: string
  /** Baseline-stock customs launch via the base's PATH binary, so they are
   *  only offered when that base is detected; configured-executable and
   *  custom-PATH agents are launch-reported (only the launch itself checks them) and never gated on
   *  client detection (oracle 35). */
  requiresDetectedBase: boolean
}

/** Ready, launch-eligible custom agents for the tab quick-launch list: a
 *  disabled custom (or one whose base harness is disabled) hard-fails at the
 *  resolver, so offering it would be a dead row. */
export function deriveTabCustomAgentEntries(
  snapshot: LocalAgentCatalogSnapshot | null,
  disabledTuiAgents: readonly TuiAgent[]
): TabCustomAgentLaunchEntry[] {
  if (!snapshot) {
    return []
  }
  const disabled = new Set<TuiAgent>(disabledTuiAgents)
  const entries: TabCustomAgentLaunchEntry[] = []
  for (const row of snapshot.customAgents) {
    if (row.status !== 'ready') {
      continue
    }
    const { definition } = row
    if (disabled.has(definition.id) || disabled.has(definition.baseAgent)) {
      continue
    }
    entries.push({
      id: definition.id,
      baseAgent: definition.baseAgent,
      label: definition.label,
      commandOverride: definition.commandOverride?.trim() || undefined,
      requiresDetectedBase: row.availabilityReason === 'baseline-stock'
    })
  }
  return entries
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

/** Owns the disabled filter for built-ins the way `deriveTabCustomAgentEntries`
 *  owns it for customs — leaving it to callers already shipped one that forgot. */
export function orderTabLaunchAgents(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detected: readonly TuiAgent[],
  customs: readonly TabCustomAgentLaunchEntry[] = [],
  disabled?: Iterable<unknown> | null
): TuiAgent[] {
  const detectedSet = new Set<TuiAgent>(detected)
  // Disabling a base hides its own row but says nothing about a custom built on
  // it — that custom is filtered by deriveTabCustomAgentEntries, not here.
  const enabledSet = new Set<TuiAgent>(filterEnabledTuiAgents(detected, disabled))
  const launchableCustoms = customs.filter(
    (custom) => !custom.requiresDetectedBase || detectedSet.has(custom.baseAgent)
  )
  const ordered: TuiAgent[] = []
  for (const entry of getAgentCatalog()) {
    if (enabledSet.has(entry.id)) {
      ordered.push(entry.id)
    }
    // Customs group under their base harness (the settings-catalog ordering);
    // a launch-reported custom is offered even when its base binary is not
    // detected, since the base row's absence says nothing about its override.
    for (const custom of launchableCustoms) {
      if (custom.baseAgent === entry.id) {
        ordered.push(custom.id)
      }
    }
  }
  if (!defaultAgent || defaultAgent === 'blank' || !ordered.includes(defaultAgent)) {
    return ordered
  }
  return [defaultAgent, ...ordered.filter((id) => id !== defaultAgent)]
}

export function buildTabAgentLaunchOptions(
  agents: readonly TuiAgent[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {},
  customs: readonly TabCustomAgentLaunchEntry[] = []
): TabAgentLaunchOption[] {
  const customsById = new Map(customs.map((custom) => [custom.id, custom]))
  return agents.map((agent) => {
    const custom = customsById.get(agent as CustomTuiAgentId)
    if (custom) {
      const aliases = new Set<string>([
        normalizeAgentAlias(custom.label),
        compactAgentAlias(custom.label)
      ])
      if (custom.commandOverride) {
        aliases.add(normalizeAgentAlias(custom.commandOverride))
        aliases.add(compactAgentAlias(custom.commandOverride))
      }
      return { agent, aliases: [...aliases], label: custom.label, baseAgent: custom.baseAgent }
    }
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
