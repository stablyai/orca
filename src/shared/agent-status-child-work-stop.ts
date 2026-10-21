import { agentChildWorkFencesEqual, type AgentChildWorkRecord } from './agent-status-child-work'
import type { AgentChildWorkStopRequest } from './agent-status-child-work-admission'
import { findAgentChildWork } from './agent-status-child-work-admission-core'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual } from './agent-status-subject'

export function authorizeAgentChildWorkStop(
  store: AgentStatusStore,
  request: AgentChildWorkStopRequest
): AgentChildWorkRecord | null {
  const child = findAgentChildWork(store, request.childWorkId)
  if (
    !child ||
    !agentStatusSubjectsEqual(child.parent, request.parent) ||
    !agentChildWorkFencesEqual(child.invocation, request.expectedFence) ||
    child.membership !== 'live' ||
    child.stoppable !== true
  ) {
    return null
  }
  return child
}
