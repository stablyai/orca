import type { AgentSessionWorkspaceSleepResult } from '../../../../shared/agent-session-workspace-sleep'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { authorityKey, SELF_LOCAL_AUTHORITY } from '../../../../shared/host-authority'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resolveOwner } from '@/lib/resolve-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { workspacePublishingHosts } from '@/store/slices/worktrees/teardown/host-twin-worktree-purge'
import type { AppState } from '@/store/types'

export type WorkspaceChatStopReceipt = {
  executionHostId: ExecutionHostId
  stoppedSessionIds: string[]
}

export type WorkspaceChatStop = { receipts: WorkspaceChatStopReceipt[]; failed: boolean }

/** One runtime per copy of the workspace; with no listing row, the workspace's route. */
function chatHostTargets(
  state: AppState,
  workspaceId: string
): Map<ExecutionHostId, RuntimeClientTarget> {
  const hosts = workspacePublishingHosts(state, workspaceId)
  const targets = new Map<ExecutionHostId, RuntimeClientTarget>()
  for (const hostId of hosts.length > 0 ? hosts : [undefined]) {
    const match = resolveOwner(state, hostId ? { workspaceId, hostId } : { workspaceId })
    const owner =
      match.kind === 'resolved'
        ? match.owner
        : match.kind === 'missing'
          ? SELF_LOCAL_AUTHORITY
          : null
    // Why null for a directly dialed SSH place: no native chat host runs there.
    const target = owner ? runtimeRpcTargetForAuthorityKey(authorityKey(owner)) : null
    if (target) {
      const key =
        target.kind === 'local'
          ? LOCAL_EXECUTION_HOST_ID
          : toRuntimeExecutionHostId(target.environmentId)
      targets.set(key, target)
    }
  }
  return targets
}

/** Each host stops only the chats it runs, so every copy's host is asked. Never rejects. */
export async function stopWorkspaceChats(
  state: AppState,
  workspaceId: string
): Promise<WorkspaceChatStop> {
  const settled = await Promise.all(
    [...chatHostTargets(state, workspaceId)].map(([executionHostId, target]) =>
      callStructuredAgentSession<AgentSessionWorkspaceSleepResult>(
        target,
        'agentSession.sleepWorkspace',
        { workspaceId }
      ).then(
        (result) => ({ executionHostId, result, error: undefined }),
        (error: unknown) => ({ executionHostId, result: null, error })
      )
    )
  )
  const receipts: WorkspaceChatStopReceipt[] = []
  let failed = false
  for (const { executionHostId, result, error } of settled) {
    if (!result || result.failures?.length) {
      failed = true
      console.error('[sleep-worktree] native chat stop incomplete', {
        workspaceId,
        executionHostId,
        failures: result?.failures,
        error
      })
    }
    if (result) {
      receipts.push({ executionHostId, stoppedSessionIds: result.stoppedSessionIds })
    }
  }
  return { receipts, failed }
}
