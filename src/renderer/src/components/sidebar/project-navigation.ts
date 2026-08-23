import type { AppState } from '@/store/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'
import type { HostSectionRow } from './host-section-rows'
import { getProjectGroupHeaderKey, PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import type { ProjectGroupingModel } from './worktree-list/grouping/project-grouping'
import type { WorktreeGroupBy } from './worktree-list/grouping/row-types'
import { getGroupKeysForWorktree } from './worktree-list/grouping/worktree-group-keys'

/** Matches folder workspaces to the same visible top-level group as worktrees. */
export function resolveTopLevelProjectGroupId(
  projectGroupId: string,
  parentGroupIdById: ReadonlyMap<string, string | null>
): string | null {
  const seen = new Set<string>()
  let id: string | null = projectGroupId
  let topId: string | null = null
  while (id !== null && !seen.has(id) && parentGroupIdById.has(id)) {
    seen.add(id)
    topId = id
    id = parentGroupIdById.get(id) ?? null
  }
  return topId
}

export type ProjectNavigationDirection = 'up' | 'down'

export type ProjectNavigationEntry = {
  /** Folder workspaces use their worktree-shaped recency and activation identity. */
  worktree: Worktree
  /** Top-level project key, or null to skip an ungroupable member. */
  projectKey: string | null
}

export type ProjectNavigationOrder = {
  /** Top-level project identity keys in sidebar order, deduped. */
  orderedProjectKeys: string[]
  /** Members grouped by their top-level project key, in sidebar order. */
  worktreesByProjectKey: Map<string, Worktree[]>
  /** Reverse lookup: which project a member belongs to. */
  projectKeyByWorktreeIdentity: Map<string, string>
}

/** Groups navigable members while preserving visible project order. */
export function buildProjectNavigationOrder(
  entries: readonly ProjectNavigationEntry[],
  preferredProjectKeys?: readonly string[]
): ProjectNavigationOrder {
  const discoveredProjectKeys: string[] = []
  const seenProjectKeys = new Set<string>()
  const worktreesByProjectKey = new Map<string, Worktree[]>()
  const projectKeyByWorktreeIdentity = new Map<string, string>()
  for (const { worktree, projectKey } of entries) {
    const identity = getWorktreeHostIdentity(worktree)
    if (!projectKey || projectKeyByWorktreeIdentity.has(identity)) {
      continue
    }
    projectKeyByWorktreeIdentity.set(identity, projectKey)
    if (!seenProjectKeys.has(projectKey)) {
      seenProjectKeys.add(projectKey)
      discoveredProjectKeys.push(projectKey)
    }
    const members = worktreesByProjectKey.get(projectKey) ?? []
    members.push(worktree)
    worktreesByProjectKey.set(projectKey, members)
  }
  const orderedProjectKeys = preferredProjectKeys
    ? [...new Set(preferredProjectKeys)].filter((key) => worktreesByProjectKey.has(key))
    : discoveredProjectKeys
  return { orderedProjectKeys, worktreesByProjectKey, projectKeyByWorktreeIdentity }
}

export function buildSidebarProjectNavigationOrder(args: {
  rows: readonly HostSectionRow[]
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repoMap: Map<string, Repo>
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
}): ProjectNavigationOrder {
  const orderedProjectKeys: string[] = []
  for (const row of args.rows) {
    if (
      row.type === 'header' &&
      row.key !== PINNED_GROUP_KEY &&
      (args.groupBy !== 'repo' || row.projectGroupDepth === 0)
    ) {
      orderedProjectKeys.push(row.key)
    }
  }
  const visibleProjectKeys = new Set(orderedProjectKeys)
  const entries: ProjectNavigationEntry[] = []
  for (const worktree of args.worktrees) {
    const projectKey =
      getGroupKeysForWorktree(
        args.groupBy,
        worktree,
        args.repoMap,
        args.prCache,
        args.workspaceStatuses,
        args.settings,
        args.projectGroups,
        args.projectGrouping
      )[0] ?? null
    if (projectKey && visibleProjectKeys.has(projectKey)) {
      entries.push({ worktree, projectKey })
    }
  }

  const parentGroupIdById = new Map(
    args.projectGroups.map((group) => [group.id, group.parentGroupId ?? null])
  )
  for (const folderWorkspace of args.folderWorkspaces) {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    const topLevelGroupId = resolveTopLevelProjectGroupId(
      folderWorkspace.projectGroupId,
      parentGroupIdById
    )
    const projectKey =
      args.groupBy === 'repo'
        ? topLevelGroupId
          ? getProjectGroupHeaderKey(topLevelGroupId)
          : null
        : (getGroupKeysForWorktree(
            args.groupBy,
            worktree,
            args.repoMap,
            args.prCache,
            args.workspaceStatuses,
            args.settings,
            args.projectGroups,
            args.projectGrouping
          )[0] ?? null)
    if (projectKey && visibleProjectKeys.has(projectKey)) {
      entries.push({ worktree, projectKey })
    }
  }

  return buildProjectNavigationOrder(entries, orderedProjectKeys)
}

export type ProjectNavigationInputs = {
  orderedProjectKeys: readonly string[]
  worktreesByProjectKey: ReadonlyMap<string, readonly Worktree[]>
  /** Project key the active workspace belongs to, or null when none is active. */
  activeProjectKey: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  lastVisitedAtByWorktreeId: Record<string, number>
  direction: ProjectNavigationDirection
}

/** Selects the target project's most recently focused workspace with wraparound. */
export function selectProjectNavigationTarget(inputs: ProjectNavigationInputs): Worktree | null {
  const {
    orderedProjectKeys,
    worktreesByProjectKey,
    activeProjectKey,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    lastVisitedAtByWorktreeId,
    direction
  } = inputs
  const count = orderedProjectKeys.length
  if (count === 0) {
    return null
  }

  const currentIndex = activeProjectKey != null ? orderedProjectKeys.indexOf(activeProjectKey) : -1
  // An off-list active project starts at the near end for the chosen direction.
  const targetIndex =
    currentIndex === -1
      ? direction === 'down'
        ? 0
        : count - 1
      : direction === 'up'
        ? (currentIndex - 1 + count) % count
        : (currentIndex + 1) % count

  const projectWorktrees = worktreesByProjectKey.get(orderedProjectKeys[targetIndex]) ?? []
  if (projectWorktrees.length === 0) {
    return null
  }

  const { switchableWorktreesForRows } = orderEmptyQueryWorktrees({
    visibleWorktrees: projectWorktrees,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    lastVisitedAtByWorktreeId
  })
  // The fallback covers a single-project wrap with only the active workspace.
  return switchableWorktreesForRows[0] ?? projectWorktrees[0] ?? null
}

export function getActiveProjectKey(
  order: ProjectNavigationOrder,
  activeWorktreeId: string | null,
  activeWorkspaceExecutionHostId: ExecutionHostId | null
): string | null {
  if (!activeWorktreeId) {
    return null
  }
  const identity = composeWorktreeHostIdentity(
    activeWorkspaceExecutionHostId ?? undefined,
    activeWorktreeId
  )
  return (
    order.projectKeyByWorktreeIdentity.get(identity) ??
    order.projectKeyByWorktreeIdentity.get(
      composeWorktreeHostIdentity(undefined, activeWorktreeId)
    ) ??
    null
  )
}
