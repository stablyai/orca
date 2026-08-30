import type { ProjectGroupingModel } from './worktree-list/grouping/project-grouping'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from './worktree-list/grouping/project-grouping'
import type { HostSectionRow } from './host-section-rows'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export type ProjectCycleDirection = 'previous' | 'next'

export type CyclableProject = {
  key: string
  worktrees: Worktree[]
}

function getProjectKey(
  repoId: string,
  repoMap: Map<string, Repo>,
  projectIndex: ReturnType<typeof buildProjectGroupingIndex>
): string {
  return getProjectGroupingForRepo(repoId, repoMap, projectIndex).key
}

export function getCyclableProjects(args: {
  rows: readonly HostSectionRow[]
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  projectGrouping?: ProjectGroupingModel
}): CyclableProject[] {
  const projectIndex = buildProjectGroupingIndex(args.projectGrouping)
  const worktreesByProjectKey = new Map<string, Worktree[]>()
  for (const worktree of args.worktrees) {
    if (worktree.isArchived) {
      continue
    }
    const key = getProjectKey(worktree.repoId, args.repoMap, projectIndex)
    const projectWorktrees = worktreesByProjectKey.get(key) ?? []
    projectWorktrees.push(worktree)
    worktreesByProjectKey.set(key, projectWorktrees)
  }

  const orderedKeys: string[] = []
  const seen = new Set<string>()
  const appendKey = (key: string): void => {
    if (!seen.has(key) && worktreesByProjectKey.has(key)) {
      seen.add(key)
      orderedKeys.push(key)
    }
  }

  // Project headers carry the exact sidebar order, including logical-project and checkout splits.
  for (const row of args.rows) {
    if (row.type === 'header' && row.repo) {
      appendKey(row.key)
    }
  }
  // Collapsed/filtered projects are absent from the rows but must remain keyboard-reachable.
  for (const repo of args.repoMap.values()) {
    appendKey(getProjectKey(repo.id, args.repoMap, projectIndex))
  }
  for (const key of worktreesByProjectKey.keys()) {
    appendKey(key)
  }

  return orderedKeys.map((key) => ({ key, worktrees: worktreesByProjectKey.get(key) ?? [] }))
}

export function getActiveProjectKey(args: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  projectGrouping?: ProjectGroupingModel
}): string | null {
  if (!args.activeWorktreeId) {
    return null
  }
  const activeWorktree = args.worktrees.find(
    (worktree) =>
      worktree.id === args.activeWorktreeId &&
      (!args.activeWorkspaceExecutionHostId ||
        getWorktreeExecutionHostId(worktree, args.repoMap.get(worktree.repoId)) ===
          args.activeWorkspaceExecutionHostId)
  )
  if (!activeWorktree) {
    return null
  }
  return getProjectKey(
    activeWorktree.repoId,
    args.repoMap,
    buildProjectGroupingIndex(args.projectGrouping)
  )
}

function pickProjectWorktree(
  worktrees: readonly Worktree[],
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
): Worktree | null {
  let mostRecent: Worktree | null = null
  let mostRecentAt = Number.NEGATIVE_INFINITY
  for (const worktree of worktrees) {
    const visitedAt = lastVisitedAtByWorktreeId[worktree.id]
    if (visitedAt !== undefined && visitedAt > mostRecentAt) {
      mostRecent = worktree
      mostRecentAt = visitedAt
    }
  }
  return mostRecent ?? worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

export function resolveCycledProjectWorktree(args: {
  projects: readonly CyclableProject[]
  activeProjectKey: string | null
  direction: ProjectCycleDirection
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
}): Worktree | null {
  if (args.projects.length < 2) {
    return null
  }

  const currentIndex = args.activeProjectKey
    ? args.projects.findIndex((project) => project.key === args.activeProjectKey)
    : -1
  const targetIndex =
    currentIndex === -1
      ? args.direction === 'next'
        ? 0
        : args.projects.length - 1
      : (currentIndex + (args.direction === 'next' ? 1 : -1) + args.projects.length) %
        args.projects.length
  return pickProjectWorktree(
    args.projects[targetIndex]?.worktrees ?? [],
    args.lastVisitedAtByWorktreeId
  )
}
