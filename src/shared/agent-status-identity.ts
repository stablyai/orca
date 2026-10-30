import { resolveCompatibleAgentTypeForOwner } from './agent-title-owner'
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

/** The accepted hook row spans pending process reads; shell proof and retirement end its applicability. */
export function resolveAgentStatusPaneOwner(
  state: {
    paneForegroundAgentByPaneKey: Record<
      string,
      { agent: AgentType | null; agentEvidence?: string; shellForeground: boolean }
    >
    agentStatusByPaneKey: Record<string, { agentType?: AgentType }>
    agentLaunchConfigByPaneKey: Record<string, { identity?: { agentType?: AgentType } }>
    recentlyRetiredAgentStatusPaneKeys: Record<string, unknown>
  },
  paneKey: string
): AgentType | undefined {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  if (
    state.recentlyRetiredAgentStatusPaneKeys[paneKey] !== undefined ||
    foreground?.shellForeground
  ) {
    return undefined
  }
  const hook = state.agentStatusByPaneKey[paneKey]?.agentType
  const launch = state.agentLaunchConfigByPaneKey[paneKey]?.identity?.agentType
  return (
    (foreground?.agentEvidence === 'process-read' ? (foreground.agent ?? undefined) : undefined) ??
    resolveCompatibleAgentTypeForOwner(hook === 'unknown' ? undefined : hook, launch) ??
    launch
  )
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  incomingProcess?: AgentProcessIdentity
  incomingSession?: string
  observedAgentType?: AgentType
  now: number
  staleAfterMs?: number
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(
    resolveCompatibleAgentTypeForOwner(args.existing?.agentType, args.observedAgentType)
  )
  const incomingAgentType = normalizedKnownAgentType(
    resolveCompatibleAgentTypeForOwner(args.incoming, args.observedAgentType)
  )

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
    agent: args.incoming ?? incomingAgentType,
    process: args.incomingProcess
  })
  if (existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      // Why: a nested `claude -p` shares the pane key; only the owner's own process speaks for it.
      inheritedFromActivePane: otherProcessOwner
    }
  }
  const owner = args.existing.agentPresence
  if (
    owner?.session &&
    !owner.ended &&
    owner.agent === args.incoming &&
    owner.session === args.incomingSession &&
    !otherProcessOwner
  ) {
    // Why: a child that posted while the owner idled must not silence the owner's own session.
    return { agentType: incomingAgentType, inheritedFromActivePane: false }
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
