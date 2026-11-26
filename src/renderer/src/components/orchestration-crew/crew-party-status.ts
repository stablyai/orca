import { mapAgentStatusStateToVisualStatus } from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import { isAgentStatusState } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/view/messages/agent-message-presentation'
import type { AgentListStatus } from '../../../../shared/agent-status/presentation/agent-list-status'

export type CrewStatusGroup = 'needsYou' | 'working' | 'idle' | 'failed'
export const CREW_STATUS_GROUPS: readonly CrewStatusGroup[] = [
  'needsYou',
  'working',
  'idle',
  'failed'
]

function dotStatus(dot: NonNullable<AgentMessageSenderView['dot']>): WorktreeStatus {
  switch (dot) {
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'idle':
      return 'inactive'
    case 'unverifiable':
      return 'unconfirmed'
    case 'working':
    case 'monitoring':
    case 'interrupted':
    case 'failed':
    case 'done':
    case 'unconfirmed':
    case 'permission':
      return dot
  }
}

export type CrewPartyState = {
  dot: AgentMessageSenderView['dot']
  /** The party's recorded agent state. */
  status: string
  taskFailed: boolean
}

/** The sidebar's status for a party: live sender state, then its record. A question to its
 *  coordinator is the coordinator's to answer, so it is not the party's own state. */
export function crewPartyStatus(party: CrewPartyState): WorktreeStatus {
  if (party.dot) {
    return dotStatus(party.dot)
  }
  const status = isAgentStatusState(party.status)
    ? mapAgentStatusStateToVisualStatus(party.status)
    : 'inactive'
  // A settled assignment whose task failed is a failure, not a quiet finish.
  return status === 'done' && party.taskFailed ? 'failed' : status
}

/** The per-agent dot the sidebar's agent rows draw, from the same inputs as the party's status. */
export function crewPartyDotState(party: CrewPartyState): AgentListStatus {
  if (party.dot) {
    return party.dot
  }
  const state = isAgentStatusState(party.status) ? party.status : 'idle'
  return state === 'done' && party.taskFailed ? 'failed' : state
}

export function crewStatusGroup(status: WorktreeStatus): CrewStatusGroup {
  switch (status) {
    case 'permission':
      return 'needsYou'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'failed':
      return 'failed'
    case 'active':
    case 'done':
    case 'inactive':
    case 'interrupted':
    case 'unconfirmed':
      return 'idle'
  }
}
