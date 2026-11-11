import type { AgentStatus } from '../../../../../shared/agent-status/title/agent-title-core'
import { detectAgentStatusFromTitle } from '../../../../../shared/agent-status/title/agent-title-status'

import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'

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
    isAgentStatusFresh(input.explicitEntry, input.now, AGENT_STATUS_STALE_AFTER_MS)
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
