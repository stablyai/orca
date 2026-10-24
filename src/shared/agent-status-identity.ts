import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'
import {
  hasOtherAgentProcessOwner,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import type { TuiAgent } from './tui-agent'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  updatedAt: number
  restoredUnconfirmed?: boolean
  agentPresence?: AgentProcessPresence
}

type AgentIdentityResolution = {
  agentType: AgentType
  inheritedFromActivePane: boolean
}

export function shouldSuppressInheritedTerminalStatus(args: {
  inheritedFromActivePane: boolean
}): boolean {
  // Nested CLIs inherit the pane key, but own neither its turn nor its children.
  return args.inheritedFromActivePane
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
  incomingProcess?: AgentProcessIdentity
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
  if (!args.existing || !existingAgentType) {
    return {
      agentType: incomingAgentType,
      inheritedFromActivePane: false
    }
  }
  const otherProcessOwner = hasOtherAgentProcessOwner(args.existing.agentPresence, {
    agent: incomingAgentType,
    process: args.incomingProcess
  })
  if (existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      // Why: a nested `claude -p` shares the pane key; only the owner's own process speaks for it.
      inheritedFromActivePane: otherProcessOwner
    }
  }
  const canonical = resolveCanonicalPaneAgentIdentity({
    hookAgent: incomingAgentType as TuiAgent,
    hookIsLive: true,
    completedHookAgent: args.existing.state === 'done' ? (existingAgentType as TuiAgent) : undefined
  })
  if (
    !args.existing.agentPresence?.suspended &&
    (otherProcessOwner || isActiveExistingIdentity(args.existing, args.now, staleAfterMs))
  ) {
    return {
      // Inherited ORCA_PANE_KEY does not grant child CLI ownership; idle leaves foreground process/resume identity intact.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }

  return {
    agentType: canonical.agent ?? incomingAgentType,
    inheritedFromActivePane: false
  }
}
