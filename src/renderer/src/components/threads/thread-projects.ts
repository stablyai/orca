import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import {
  findIndexedRepoOwnerForHost,
  worktreeOwnerHostIds
} from '@/lib/worktree-runtime-owner-index'
import type { AppState } from '@/store/types'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { structuredAgentSessionHostSupports } from '@/runtime/structured-agent-session-client'
import { AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'

export type ThreadProject = { key: string; repo: Repo; worktree: Worktree; hostId: ExecutionHostId }

export function threadProjectForLocation(
  state: Pick<AppState, 'repos' | 'worktreesByRepo' | 'folderWorkspaces' | 'projectGroups'>,
  location: { workspaceId: string; executionHostId: ExecutionHostId }
): Repo | null {
  const worktree = selectWorkspaceByHostTarget(
    state,
    hostWorktreeTarget({ id: location.workspaceId, hostId: location.executionHostId })
  )
  if (!worktree) {
    return null
  }
  const repo = findIndexedRepoOwnerForHost(state.repos, worktree.repoId, location.executionHostId)
  return repo &&
    (worktree.isMainWorktree || (repo.kind === 'folder' && worktree.path === repo.path))
    ? repo
    : null
}

export function threadProjectCandidates(state: AppState): ThreadProject[] {
  const result = new Map<string, ThreadProject>()
  const visited = new Map<string, number>()
  for (const rows of Object.values(selectWorktreesByRepo(state))) {
    for (const worktree of rows) {
      const hosts = worktreeOwnerHostIds(worktree)
      const hostId = hosts.at(-1) ?? 'local'
      const key = `${hostId}|${worktree.repoId}`
      visited.set(
        key,
        Math.max(visited.get(key) ?? 0, state.lastVisitedAtByWorktreeId[worktree.id] ?? 0)
      )
      const repo = threadProjectForLocation(state, {
        workspaceId: worktree.id,
        executionHostId: hostId
      })
      if (repo && structuredAgentSessionTargetForHost(hostId)) {
        result.set(key, { key, repo, worktree, hostId })
      }
    }
  }
  const activeHost = state.activeWorkspaceExecutionHostId ?? 'local'
  const active = state.activeWorktreeId
    ? selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: state.activeWorktreeId, hostId: activeHost })
      )
    : null
  const activeKey = active ? `${activeHost}|${active.repoId}` : null
  return [...result.values()].sort(
    (a, b) =>
      Number(b.key === activeKey) - Number(a.key === activeKey) ||
      (visited.get(b.key) ?? 0) - (visited.get(a.key) ?? 0) ||
      b.repo.addedAt - a.repo.addedAt
  )
}

export async function eligibleThreadProjects(state: AppState): Promise<ThreadProject[]> {
  const candidates = threadProjectCandidates(state)
  const supported = await Promise.all(
    candidates.map(async (project) => {
      const target = structuredAgentSessionTargetForHost(project.hostId)
      return (
        target &&
        (await structuredAgentSessionHostSupports(
          target,
          AGENT_SESSION_CREATE_SURFACE_RUNTIME_CAPABILITY
        ))
      )
    })
  )
  return candidates.filter((_, index) => supported[index])
}
