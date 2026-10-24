import { useSyncExternalStore } from 'react'
import type { StructuredLaunchFailure } from './structured-agent-session-launch-failure'
import {
  subscribeStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchFailure,
  getStructuredAgentSessionLaunchLifecycle,
  structuredLaunchIdentity,
  structuredLaunchStates,
  type StructuredAgentLaunchStatus,
  type StructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch-registry'
import type { TuiAgent } from '../../../shared/tui-agent'
import { structuredLaunchesHoldingIdentity } from './structured-agent-session-launch-holders'

/** Whether a chat for this pair is being created here: its own first create, or an adoption. */
export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: TuiAgent
): StructuredAgentLaunchStatus {
  // Any launch holding an identity for this pair, adopted conversations included, is starting here.
  // A failed chat is not, nor an unconfirmed or retried blank one: a new launch opens its own chat.
  const identity = structuredLaunchIdentity(worktreeId, agent)
  const states = structuredLaunchesHoldingIdentity(
    (candidate) => candidate === identity || candidate.startsWith(`${identity}:resume:`)
  )
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}

/** Whether any agent's chat create in this worktree is still unsettled: pending or unanswered. */
export function hasStructuredAgentLaunchInWorktree(worktreeId: string): boolean {
  for (const state of structuredLaunchStates()) {
    if (
      state.intent.worktreeId === worktreeId &&
      getStructuredAgentLaunchStatus(worktreeId, state.intent.agent) !== 'idle'
    ) {
      return true
    }
  }
  return false
}

export function useStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchFailure(worktreeId, sessionId),
    () => null
  )
}

export function useStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId),
    () => null
  )
}

export { launchStateLifecycle } from './structured-agent-session-launch-lifecycle'
