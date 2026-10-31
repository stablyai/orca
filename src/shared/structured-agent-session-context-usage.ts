// Turn rows persist context facts across restart; writes target open/newest turns and replace their namesake, so newest facts win.

import {
  contextTokensFromUsage,
  type AgentSessionContextUsage,
  type AgentSessionContextUsageCategory,
  type AgentSessionContextUsed,
  type AgentSessionContextWindow
} from './agent-session-context-usage'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn } from './agent-session-turn-record'
import {
  isAgentSessionContextClear,
  latestAgentSessionContextClearSequence
} from './agent-session-context-clear'

export type StructuredAgentContextUsage = {
  usedTokens: number
  windowTokens: number
  /** Rounded and unclamped, so an over-limit session reads above 100. */
  percentage: number
  /** True when the count comes from the last response rather than a report. */
  estimated: boolean
  /** The provider's breakdown; empty for an estimate. */
  categories: readonly AgentSessionContextUsageCategory[]
}

type ContextFactSource = Pick<AgentJournalRenderItem, 'sequence' | 'body'>

/** Resolve each newest fact independently in any iteration order; missing parts stay absent. */
export function latestStructuredAgentContextFacts(
  items: Iterable<ContextFactSource>,
  minimumSequence = 0
): AgentSessionContextUsage {
  let used: { sequence: number; fact: AgentSessionContextUsed } | null = null
  let window: { sequence: number; fact: AgentSessionContextWindow } | null = null
  for (const item of items) {
    if (isAgentSessionContextClear(item.body) && item.sequence > minimumSequence) {
      minimumSequence = item.sequence
      if (used && used.sequence <= minimumSequence) {
        used = null
      }
      if (window && window.sequence <= minimumSequence) {
        window = null
      }
    }
    if (item.sequence <= minimumSequence) {
      continue
    }
    const facts = readAgentJournalTurn(item.body)?.contextUsage
    if (facts?.used && (used === null || item.sequence >= used.sequence)) {
      used = { sequence: item.sequence, fact: facts.used }
    }
    if (facts?.window && (window === null || item.sequence >= window.sequence)) {
      window = { sequence: item.sequence, fact: facts.window }
    }
  }
  return { ...(used ? { used: used.fact } : {}), ...(window ? { window: window.fact } : {}) }
}

/** Loaded rows reach the live head and outrank wholeJournal; use the host answer only for missing parts from older rows. */
export function selectStructuredAgentContextUsage(
  items: readonly AgentJournalRenderItem[],
  wholeJournal?: AgentSessionContextUsage,
  minimumSequence = 0
): StructuredAgentContextUsage | null {
  const clearedSequence = latestAgentSessionContextClearSequence(items)
  const loaded = latestStructuredAgentContextFacts(
    items,
    Math.max(minimumSequence, clearedSequence)
  )
  const fallback = clearedSequence > minimumSequence ? undefined : wholeJournal
  return summarizeStructuredAgentContextFacts({ ...fallback, ...loaded })
}

function summarizeStructuredAgentContextFacts({
  used: fact,
  window
}: AgentSessionContextUsage): StructuredAgentContextUsage | null {
  if (fact?.kind === 'report') {
    return {
      usedTokens: fact.usedTokens,
      windowTokens: fact.windowTokens,
      percentage: fact.percentage,
      estimated: false,
      categories: fact.categories
    }
  }
  // `unknown`, or a kind a newer host writes that this client cannot measure.
  if (fact?.kind !== 'estimate') {
    return null
  }
  // The writer holds estimates back across a model change, so the newest window is this model's.
  if (!window) {
    return null
  }
  const usedTokens = contextTokensFromUsage(fact.usage)
  return {
    usedTokens,
    windowTokens: window.tokens,
    percentage: Math.round((usedTokens / window.tokens) * 100),
    estimated: true,
    categories: []
  }
}
