import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { AgentStatusExecutionBinding } from './agent-status-run'
import { makePaneKey } from './stable-pane-id'
import { worktreeIdsEqual } from './worktree/id'

export type AgentSessionStatusBindingOwner = {
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  statusBinding: AgentStatusExecutionBinding
}

export function findClaimedAgentStatusBinding(args: {
  live: Iterable<AgentSessionStatusBindingOwner>
  reserved: Iterable<AgentSessionStatusBindingOwner>
  paneKey: string
  worktreeId?: string
  agent?: string
  role?: 'root' | 'child'
  runId: string
  executionId: string
}): AgentStatusExecutionBinding | null {
  const matches: AgentStatusExecutionBinding[] = []
  const consider = (owner: AgentSessionStatusBindingOwner): void => {
    if (
      makePaneKey(owner.surface.tabId, owner.surface.leafId) !== args.paneKey ||
      (args.worktreeId !== undefined &&
        !worktreeIdsEqual(owner.surface.worktreeId, args.worktreeId)) ||
      (args.agent !== undefined && owner.claim.agent !== args.agent) ||
      (args.role !== undefined && owner.statusBinding.role !== args.role) ||
      owner.statusBinding.runId !== args.runId ||
      owner.statusBinding.attachment.executionId !== args.executionId
    ) {
      return
    }
    matches.push(owner.statusBinding)
  }
  for (const owner of args.live) {
    consider(owner)
  }
  for (const owner of args.reserved) {
    consider(owner)
  }
  return matches.length === 1 ? { ...matches[0], attachment: { ...matches[0].attachment } } : null
}
