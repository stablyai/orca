import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getExecutionHostLabel,
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ProjectGroupingIndex, WorktreeGroupEntry } from './project-grouping'

function getRepoHostLabel(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): string | null {
  const setup = projectIndex?.setupByRepoId.get(repoId)
  if (setup) {
    return hostLabelById?.get(setup.hostId) ?? getExecutionHostLabel(setup.hostId)
  }
  const repo = repoMap.get(repoId)
  if (!repo) {
    return null
  }
  const hostId = getRepoExecutionHostId(repo)
  return hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
}

export function getMixedHostContextLabels(
  group: WorktreeGroupEntry,
  repoMap: Map<string, Repo>,
  projectIndex: ProjectGroupingIndex | null,
  hostLabelById: ReadonlyMap<string, string> | undefined
): Map<string, string> | undefined {
  const labelsByRepoId = new Map<string, string>()
  const uniqueLabels = new Set<string>()
  for (const repoId of group.repoIds) {
    const label = getRepoHostLabel(repoId, repoMap, projectIndex, hostLabelById)
    if (!label) {
      continue
    }
    labelsByRepoId.set(repoId, label)
    uniqueLabels.add(label)
  }
  return uniqueLabels.size > 1 ? labelsByRepoId : undefined
}

/** Keyed by host-qualified identity: two hosts sharing an id need two labels. */
export function getMixedWorktreeHostContextLabels(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  hostLabelById: ReadonlyMap<string, string> | undefined,
  defaultHostId: ExecutionHostId
): Map<string, string> | undefined {
  const labelsByIdentity = new Map<string, string>()
  const uniqueHostIds = new Set<ExecutionHostId>()
  for (const worktree of worktrees) {
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    uniqueHostIds.add(hostId)
    labelsByIdentity.set(
      getWorktreeHostIdentity(worktree),
      hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
    )
  }
  return uniqueHostIds.size > 1 ? labelsByIdentity : undefined
}

export function getHostWorktreeCounts(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, number> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  const counts = new Map<ExecutionHostId, number>()
  // Dedup by host, not by bare id: the same id on two hosts is two workspaces
  // and has to be counted under each of them (STA-4343).
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    if (seenIdentities.has(getWorktreeHostIdentity(worktree))) {
      continue
    }
    seenIdentities.add(getWorktreeHostIdentity(worktree))
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    counts.set(hostId, (counts.get(hostId) ?? 0) + 1)
  }
  return counts
}

export function getHostWorktreeIds(
  worktrees: readonly Worktree[],
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): Map<ExecutionHostId, string[]> | undefined {
  if (worktrees.length === 0) {
    return undefined
  }
  const idsByHost = new Map<ExecutionHostId, string[]>()
  const seenIdentities = new Set<string>()
  for (const worktree of worktrees) {
    if (seenIdentities.has(getWorktreeHostIdentity(worktree))) {
      continue
    }
    seenIdentities.add(getWorktreeHostIdentity(worktree))
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    const ids = idsByHost.get(hostId) ?? []
    ids.push(worktree.id)
    idsByHost.set(hostId, ids)
  }
  return idsByHost
}
