import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'
import { parseCustomTuiAgentId } from './custom-tui-agent-identity'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
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
  // A custom id and its base are the SAME harness: a custom-seeded row's hooks
  // report the base (hooks never carry the custom id), so treating them as a
  // nested child would suppress the pane's own `done` forever. Keep the custom
  // (requested) label so the row is never relabeled to the base. Two distinct
  // custom ids stay distinct and fall through to the inheritance rule.
  const existingCustom = parseCustomTuiAgentId(existingAgentType)
  const incomingCustom = parseCustomTuiAgentId(incomingAgentType)
  if (
    (existingCustom === null) !== (incomingCustom === null) &&
    (existingCustom?.baseAgent ?? existingAgentType) ===
      (incomingCustom?.baseAgent ?? incomingAgentType)
  ) {
    return {
      agentType: existingCustom ? existingAgentType : incomingAgentType,
      inheritedFromActivePane: false
    }
  }
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
    agentType: incomingAgentType,
    inheritedFromActivePane: false
  }
}
