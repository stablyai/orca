import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { workspaceKindForWorktreeId } from '../../../../../../shared/agent-launch/contracts/workspace-launch-kind'
import type { ProspectiveWorkspace } from './agent-launch-route-input'

export const worktreeLaunchWorkspace = (
  worktreeId: string,
  hostId?: ExecutionHostId
): ProspectiveWorkspace => ({
  kind: workspaceKindForWorktreeId(worktreeId),
  worktreeId,
  ...(hostId ? { hostId } : {})
})
