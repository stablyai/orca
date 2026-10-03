import { isSameAgentProcess, type AgentProcessPresence } from './agent-process-presence'
import { worktreeIdsEqual } from './worktree/id'

type RecordedOwner = {
  presence?: AgentProcessPresence
  connectionId: string | null
  worktreeId?: string
}

/** Both execution hosts use this rule; it decides ownership and never touches a turn. */
export function canAdmitAgentForeground(
  recorded: RecordedOwner | undefined,
  presence: AgentProcessPresence,
  scope: { connectionId: string | null; worktreeId?: string },
  /** This host just proved the recorded owner stopped (Ctrl-Z); the new process holds the terminal. */
  recordedSuspended = false
): boolean {
  if (!presence.process || presence.ended) {
    return false
  }
  const owner = recorded?.presence?.process
  if (!recorded || !owner) {
    return true
  }
  if (
    recorded.connectionId !== scope.connectionId ||
    (recorded.worktreeId &&
      scope.worktreeId &&
      !worktreeIdsEqual(recorded.worktreeId, scope.worktreeId))
  ) {
    return false
  }
  if (isSameAgentProcess(owner, presence.process)) {
    return false
  }
  // A running owner is never replaced; only an ended or a stopped one yields its terminal.
  return recorded.presence?.ended === true || recordedSuspended
}
