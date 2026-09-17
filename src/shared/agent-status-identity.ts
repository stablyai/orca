import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import { isAgentStatusTurnComplete } from './agent-completion-time'
import type { TuiAgent } from './tui-agent'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  sessionBoundary?: boolean
  updatedAt: number
  restoredUnconfirmed?: boolean
}

type AgentIdentityResolution = {
  agentType: AgentType
  inheritedFromActivePane: boolean
}

export function shouldSuppressInheritedTerminalStatus(args: {
  inheritedFromActivePane: boolean
  incomingState: AgentStatusState
}): boolean {
  // Why: nested child hooks inherit the parent's ORCA_PANE_KEY. A child
  // completion does not prove the active parent turn completed.
  return args.inheritedFromActivePane && args.incomingState === 'done'
}

function normalizedKnownAgentType(agentType: AgentType | null | undefined): AgentType | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return agentType
}

function isActiveExistingIdentity(
  existing: ExistingAgentIdentity,
  now: number,
  staleAfterMs: number
): boolean {
  return isFreshNonDoneAgentStatus(existing, now, staleAfterMs)
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  now: number
  staleAfterMs?: number
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(args.existing?.agentType)
  const incomingAgentType = normalizedKnownAgentType(args.incoming)

  if (!incomingAgentType) {
    return {
      agentType: existingAgentType ?? 'unknown',
      inheritedFromActivePane: false
    }
  }
  if (!args.existing || !existingAgentType || existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      inheritedFromActivePane: false
    }
  }
  const canonical = resolveCanonicalPaneAgentIdentity({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: normalizedAgentType is an arbitrary AgentType string; the canonical adapter only accepts recognized TUI agent literals and falls back when unknown.
    hookAgent: incomingAgentType as TuiAgent,
    hookIsLive: true,
    completedHookAgent: isAgentStatusTurnComplete(args.existing)
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existingAgentType is normalized to a non-empty known AgentType; the canonical adapter uses the TuiAgent literal domain for completed evidence.
        (existingAgentType as TuiAgent)
      : undefined
  })
  if (isActiveExistingIdentity(args.existing, args.now, staleAfterMs)) {
    return {
      // Why: child agent CLIs inherit ORCA_PANE_KEY from their parent terminal.
      // While the parent turn is active, do not let a nested hook steal the
      // pane's visible identity.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }

  return {
    agentType: canonical.agent ?? incomingAgentType,
    inheritedFromActivePane: false
  }
}
