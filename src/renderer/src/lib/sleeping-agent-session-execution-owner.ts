import type { useAppStore } from '@/store'
import { getSleepingAgentSessionExecutionHostId } from '../../../shared/agent-session-resume'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type AppStoreState = ReturnType<typeof useAppStore.getState>
type AgentSessionExecutionOwnedRecord = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  connectionId?: string | null
}

function legacySleepingRecordOwnerMatches(
  state: AppStoreState,
  record: AgentSessionExecutionOwnedRecord,
  expectedExecutionHostId: ExecutionHostId
): boolean {
  const ownerIds = new Set<ExecutionHostId>()
  const worktrees = [
    ...(typeof state.allWorktrees === 'function' ? state.allWorktrees() : []),
    ...Object.values(state.worktreesByRepo ?? {}).flat(),
    ...Object.values(state.detectedWorktreesByRepo ?? {}).flatMap((entry) => entry?.worktrees ?? [])
  ].filter((worktree) => worktree.id === record.worktreeId)
  for (const worktree of worktrees) {
    const explicitHost = parseExecutionHostId(worktree.hostId)
    if (explicitHost) {
      ownerIds.add(explicitHost.id)
      continue
    }
    const repos = state.repos.filter((repo) => repo.id === worktree.repoId)
    if (repos.length === 0) {
      ownerIds.add(LOCAL_EXECUTION_HOST_ID)
    } else {
      for (const repo of repos) {
        ownerIds.add(getRepoExecutionHostId(repo))
      }
    }
  }
  const workspaceScope = parseWorkspaceKey(record.worktreeId)
  if (workspaceScope?.type === 'folder') {
    for (const workspace of state.folderWorkspaces ?? []) {
      if (workspace.id !== workspaceScope.folderWorkspaceId) {
        continue
      }
      const owner = parseExecutionHostId(workspace.executionHostId)
      if (owner) {
        ownerIds.add(owner.id)
      }
    }
  }
  if (ownerIds.size === 0) {
    const knownWorktree = state.getKnownWorktreeById?.(record.worktreeId, expectedExecutionHostId)
    const knownHost = parseExecutionHostId(knownWorktree?.hostId)
    if (knownHost) {
      ownerIds.add(knownHost.id)
    }
  }
  if (ownerIds.size === 0) {
    return expectedExecutionHostId === LOCAL_EXECUTION_HOST_ID
  }
  return ownerIds.size === 1 && ownerIds.has(expectedExecutionHostId)
}

export function sleepingAgentSessionRecordMatchesExecutionHost(
  state: AppStoreState,
  record: AgentSessionExecutionOwnedRecord,
  expectedExecutionHostId: ExecutionHostId
): boolean {
  if (record.executionHostId !== undefined && !parseExecutionHostId(record.executionHostId)) {
    return false
  }
  const recordExecutionHostId = getSleepingAgentSessionExecutionHostId(record)
  return recordExecutionHostId
    ? recordExecutionHostId === expectedExecutionHostId
    : legacySleepingRecordOwnerMatches(state, record, expectedExecutionHostId)
}
