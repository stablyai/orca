import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  updatedAt: number
  /** tmux pane the stored status came from, when the hook source reported one. */
  tmuxPaneRef?: string
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

// Why: agents in separate tmux panes inherit one ORCA_PANE_KEY, so a differing
// pane ref is nesting evidence even when both report the same agent type.
// An absent ref on either side proves nothing; treat it as the same pane.
function isNestedByTmuxPane(
  existingTmuxPaneRef: string | undefined,
  incomingTmuxPaneRef: string | undefined
): boolean {
  if (!existingTmuxPaneRef || !incomingTmuxPaneRef) {
    return false
  }
  return existingTmuxPaneRef !== incomingTmuxPaneRef
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  incomingTmuxPaneRef?: string
  now: number
  staleAfterMs?: number
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(args.existing?.agentType)
  const incomingAgentType = normalizedKnownAgentType(args.incoming)
  const nestedByTmuxPane = isNestedByTmuxPane(args.existing?.tmuxPaneRef, args.incomingTmuxPaneRef)

  if (!incomingAgentType) {
    return {
      agentType: existingAgentType ?? 'unknown',
      inheritedFromActivePane: false
    }
  }
  if (
    !args.existing ||
    !existingAgentType ||
    (existingAgentType === incomingAgentType && !nestedByTmuxPane)
  ) {
    return {
      agentType: incomingAgentType,
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
