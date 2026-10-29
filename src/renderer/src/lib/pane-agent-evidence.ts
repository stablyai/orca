import type { AgentStatus } from '../../../shared/agent-detection'
import { detectAgentStatusFromTitle, getAgentLabel } from '../../../shared/agent-detection'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../shared/agent-status-types'
import { isAgentStatusFresh } from '../../../shared/agent-status-freshness'

// Hook status can outlive exited agents; share one configurable-TTL freshness gate without aggregate/resolver import cycles.
export function isExplicitAgentStatusFresh(
  entry: Pick<
    AgentStatusEntry,
    | 'updatedAt'
    | 'evidenceObservedAt'
    | 'mirroredEvidenceReceivedAt'
    | 'restoredUnconfirmed'
    | 'structuredHostOwned'
  >,
  now: number,
  staleAfterMs: number
): boolean {
  return isAgentStatusFresh(entry, now, staleAfterMs)
}

/** Title-only consumers (timers, readiness, sorting, synthetic writes) intentionally ignore hook/liveness evidence. */
export function classifyTitleActivity(title: string): AgentStatus | null {
  return detectAgentStatusFromTitle(title)
}

/** Activity may treat bare Claude status prefixes as a label; committed identity requires agent proof. Choose the facet matching the product rule. */
export function resolveTitleActivityLabel(title: string): string | null {
  return getAgentLabel(title)
}

/** See resolveTitleActivityLabel — the strict facet for identity decisions. */
export function resolveCommittedTitleAgentType(title: string): TerminalAgent | null {
  return resolveExplicitTerminalTitleAgentType(title)
}

/** Expose hook/title layers separately: send menus and workspace dots combine them differently, so merging would change behavior. */
export type AgentActivityDecision = {
  /** Fresh (within AGENT_STATUS_STALE_AFTER_MS), pane-scoped hook state; null when absent or stale. */
  hookState: AgentStatusState | null
  /** Agent identity from the fresh hook row, when one exists. */
  hookAgentType: AgentType | undefined
  /** Title-derived status of the pane's live title, independent of hook state. */
  titleStatus: AgentStatus | null
  /** Which evidence layer holds the strongest current claim. */
  source: 'hook' | 'title' | 'none'
  confidence: 'authoritative' | 'fallback'
  /** True when the only claim is a title without live-PTY proof — liveness-gated consumers must treat it as absent. */
  livePtyRequired: boolean
}

export type ResolvePaneAgentActivityInput = {
  explicitEntry: AgentStatusEntry | undefined
  liveTitle: string | null
  hasLivePty: boolean
  now: number
}

export function resolvePaneAgentActivity(
  input: ResolvePaneAgentActivityInput
): AgentActivityDecision {
  const freshEntry =
    input.explicitEntry &&
    isExplicitAgentStatusFresh(input.explicitEntry, input.now, AGENT_STATUS_STALE_AFTER_MS)
      ? input.explicitEntry
      : null
  const titleStatus = input.liveTitle !== null ? detectAgentStatusFromTitle(input.liveTitle) : null
  if (freshEntry) {
    return {
      hookState: freshEntry.state,
      hookAgentType: freshEntry.agentType,
      titleStatus,
      source: 'hook',
      confidence: 'authoritative',
      livePtyRequired: false
    }
  }
  if (titleStatus !== null) {
    return {
      hookState: null,
      hookAgentType: undefined,
      titleStatus,
      source: 'title',
      confidence: 'fallback',
      livePtyRequired: !input.hasLivePty
    }
  }
  return {
    hookState: null,
    hookAgentType: undefined,
    titleStatus: null,
    source: 'none',
    confidence: 'authoritative',
    livePtyRequired: false
  }
}
