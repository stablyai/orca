import type { AgentStatus } from '../../../shared/agent-detection'
import { detectAgentStatusFromTitle, getAgentLabel } from '../../../shared/agent-detection'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../shared/agent-status-types'

// Why: explicit agent status entries (from hook-based reports) can go stale if
// the agent process exits without sending a final update. This helper lets
// callers decide whether to trust the entry based on a configurable TTL.
// (Moved here from agent-status.ts so the evidence resolvers below and the
// aggregate consumers share one gate without an import cycle.)
export function isExplicitAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt'>,
  now: number,
  staleAfterMs: number
): boolean {
  return now - entry.updatedAt <= staleAfterMs
}

/**
 * Title-only activity classification for consumers whose product rule really
 * is "what does this title say" (timer seeding, ready-wait polling, sort-epoch
 * comparison, synthetic-title writing) — they combine no hook/liveness
 * evidence, so routing them through the pane resolver would misstate intent.
 */
export function classifyTitleActivity(title: string): AgentStatus | null {
  return detectAgentStatusFromTitle(title)
}

/**
 * The two facets of title-derived agent identity. The ACTIVITY LABEL treats
 * Claude's bare status prefixes (spinner/`✳`/`. `/`* `) as Claude activity;
 * COMMITTED identity rejects them — evidence that something runs is not proof
 * of who. Consumers historically split on this by accident; pick the facet
 * that matches the product rule, never both out of habit.
 */
export function resolveTitleActivityLabel(title: string): string | null {
  return getAgentLabel(title)
}

/** See resolveTitleActivityLabel — the strict facet for identity decisions. */
export function resolveCommittedTitleAgentType(title: string): TuiAgent | null {
  return resolveExplicitTerminalTitleAgentType(title)
}

/**
 * Combined pane activity evidence for aggregate consumers. The hook and title
 * layers are exposed separately on purpose: consumers legitimately combine
 * them differently (send targets let a live permission title override a fresh
 * working hook; the worktree dot suppresses titles on hook-covered panes), so
 * a single merged status would silently change behavior.
 */
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

// Deliberately absent: a resolvePaneAgentOwner precedence resolver. The only
// Phase 2 identity consumer (native-chat toggle) reads hook identity without a
// freshness gate, so a gated owner resolver would change its behavior; the
// owner resolver lands with its first real consumer in a later slice.
