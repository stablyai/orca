import { foldAgentLeadStatus } from './agent-lead-status-fold'
import type { AgentSessionBackgroundTaskRunState } from './agent-session-background-task-wire'
import type { AgentChildWorkId, AgentChildWorkOutcome } from './agent-status-child-work'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentStatusState } from './agent-status-types'
import { groupedBy } from './grouped-by'

// Keep renderer-safe display policy separate from projection, whose status-subject owner resolution reaches host-only code.

type AgentChildWorkOwnershipView = Pick<
  AgentChildWorkView,
  'id' | 'kind' | 'state' | 'membership' | 'parentChildWorkId'
>

/** Liveness of all live work beneath a child, at any depth — the same input a parent row folds. */
export function agentChildWorkOwnedLiveness(
  views: readonly AgentChildWorkOwnershipView[],
  ownerId: AgentChildWorkId
): AgentChildWorkLiveness {
  const owned = groupedBy(views, (view) => view.parentChildWorkId)
  const seen = new Set<AgentChildWorkId>([ownerId])
  const frontier = [ownerId]
  const liveDescendants: AgentChildWorkOwnershipView[] = []
  for (let owner = frontier.pop(); owner !== undefined; owner = frontier.pop()) {
    for (const view of owned.get(owner) ?? []) {
      if (!seen.has(view.id)) {
        seen.add(view.id)
        frontier.push(view.id)
        if (view.membership === 'live') {
          liveDescendants.push(view)
        }
      }
    }
  }
  return agentChildWorkLiveness(liveDescendants)
}

/** The dot a child row renders; every value is an `AgentStateDot` state. */
export type AgentChildDisplayState =
  | 'working'
  | 'monitoring'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'idle'
  | 'unverifiable'

const SETTLED_DISPLAY_STATE: Record<AgentChildWorkOutcome, AgentChildDisplayState> = {
  succeeded: 'done',
  failed: 'failed',
  cancelled: 'interrupted',
  // Neutral: an ending the lane cannot classify asserts nothing.
  unknown: 'idle'
}

/** Use the parent fold: idle/finished children enter as done, so owned live shells yield monitoring. unverifiable bypasses it as a freshness verdict. */
export function deriveAgentChildDisplayState(
  view: Pick<AgentChildWorkView, 'state' | 'membership' | 'outcome'>,
  ownedLiveness: AgentChildWorkLiveness
): AgentChildDisplayState {
  if (view.state === 'unverifiable') {
    return 'unverifiable'
  }
  // Stored only by a shell or a monitor, and neither owns work.
  if (view.state === 'monitoring') {
    return 'monitoring'
  }
  const leadState: AgentStatusState =
    view.membership === 'settled' || view.state === 'done' || view.state === 'idle'
      ? 'done'
      : view.state
  // A child's cancel never hides the work it left running.
  const foldInput = { leadState, childWorkLiveness: ownedLiveness, interrupted: false }
  const folded = foldAgentLeadStatus(foldInput)
  if (folded.stateName !== 'done') {
    return folded.workingMode ?? folded.stateName
  }
  return view.membership === 'live' ? 'idle' : SETTLED_DISPLAY_STATE[view.outcome ?? 'unknown']
}

/** Legacy run vocabulary maps failure to blocked and cancellation to idle; the child dot retains the actual outcome. */
export function agentChildRunStateFor(
  displayState: AgentChildDisplayState
): AgentSessionBackgroundTaskRunState {
  switch (displayState) {
    case 'failed':
      return 'blocked'
    case 'interrupted':
      return 'idle'
    case 'working':
    case 'monitoring':
    case 'waiting':
    case 'blocked':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return displayState
  }
}
