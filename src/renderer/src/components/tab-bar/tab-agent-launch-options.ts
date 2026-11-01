import {
  searchAgentPickerSetups,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'
import { rowLabel, rowId, chatUnavailableLabel } from './tab-agent-row-presentation'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { orderAgentLaunchPickerAgents } from '../../../../shared/agent-launch-picker-rows'
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
  setup?: AgentPickerDraft
  pickerEntry?: AgentPickerEntry
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
  return orderAgentLaunchPickerAgents(defaultAgent, detected, disabled)
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

export function buildAgentPickerLaunchOptions(
  entries: readonly AgentPickerEntry[],
  commandOverrides: Partial<Record<TuiAgent, string>> = {}
): TabAgentLaunchOption[] {
  return entries.flatMap((entry) => {
    const row = entry.rows.find((row) =>
      entry.defaultSurface === 'chat'
        ? row.kind === 'chat'
        : row.kind === 'cli' || row.kind === 'terminal'
    )
    return row
      ? buildTabAgentLaunchOptionsFromRows([row], commandOverrides).map((option) => ({
          ...option,
          label: entry.label,
          pickerEntry: entry
        }))
      : []
  })
}

// Require exact aliases or token prefixes; substring hits would outrank files and hijack the omnibox.
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
        // Require exact tokens below two characters to avoid accidental one-keystroke agent launches.
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

export function matchingAgentPickerLaunchOptions(
  entries: readonly AgentPickerEntry[],
  query: string
): TabAgentLaunchOption[] {
  return searchAgentPickerSetups(entries, query).map((setup) => {
    const surface = setup.entry.defaultSurface
    return {
      agent: setup.entry.agent,
      label: setup.label,
      aliases: [],
      id: `setup:${setup.entry.agent}:${setup.model.id}:${setup.choices.options?.effort ?? ''}:${surface}`,
      row: {
        agent: setup.entry.agent,
        kind: surface === 'chat' ? 'chat' : 'cli',
        executionHostId: setup.entry.rows[0]?.executionHostId
      },
      setup: { agent: setup.entry.agent, surface, choices: setup.choices },
      pickerEntry: setup.entry
    }
  })
}

export function configuredAgentPickerLaunchOption(
  option: TabAgentLaunchOption,
  draft: AgentPickerDraft
): TabAgentLaunchOption {
  return {
    ...option,
    row: {
      agent: draft.agent,
      kind: draft.surface === 'chat' ? 'chat' : 'cli',
      executionHostId: option.row?.executionHostId
    },
    setup: draft
  }
}
