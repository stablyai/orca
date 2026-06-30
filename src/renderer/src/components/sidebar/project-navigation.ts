import type { Worktree } from '../../../../shared/types'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'

/**
 * Walk a project group to its outermost in-map ancestor (the top-level project).
 * `parentGroupIdById` maps each known group id to its parent (null for roots).
 * Returns the top-level group id, or null when the starting group is unknown.
 * Mirrors getGroupKeysForWorktree's ancestor walk so a folder workspace and a
 * worktree in the same top-level group collapse to the same cycle stop.
 */
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
  /**
   * A navigable sidebar member. Folder workspaces are passed as their
   * `folderWorkspaceToWorktree` form, so worktrees and folder workspaces share
   * one recency/activation id (the value `activeWorktreeId` also holds).
   */
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
  projectKeyByWorktreeId: Map<string, string>
}

/**
 * Collapse ordered sidebar members into their top-level projects. The caller
 * passes entries in sidebar order (pinned duplicates already removed so the
 * cycle order follows the visible section headers) with each member's
 * pre-resolved top-level project key. Order is first-appearance; members with
 * no project key are skipped. Pure so the derivation stays unit-testable.
 */
export function buildProjectNavigationOrder(
  entries: readonly ProjectNavigationEntry[]
): ProjectNavigationOrder {
  const orderedProjectKeys: string[] = []
  const seenProjectKeys = new Set<string>()
  const worktreesByProjectKey = new Map<string, Worktree[]>()
  const projectKeyByWorktreeId = new Map<string, string>()
  for (const { worktree, projectKey } of entries) {
    if (!projectKey || projectKeyByWorktreeId.has(worktree.id)) {
      continue
    }
    projectKeyByWorktreeId.set(worktree.id, projectKey)
    if (!seenProjectKeys.has(projectKey)) {
      seenProjectKeys.add(projectKey)
      orderedProjectKeys.push(projectKey)
    }
    const members = worktreesByProjectKey.get(projectKey) ?? []
    members.push(worktree)
    worktreesByProjectKey.set(projectKey, members)
  }
  return { orderedProjectKeys, worktreesByProjectKey, projectKeyByWorktreeId }
}

export type ProjectNavigationInputs = {
  orderedProjectKeys: readonly string[]
  worktreesByProjectKey: ReadonlyMap<string, readonly Worktree[]>
  /** Project key the active worktree belongs to, or null when none is active. */
  activeProjectKey: string | null
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Record<string, number>
  direction: ProjectNavigationDirection
}

/**
 * Pick which worktree to activate when cycling to the next/previous project.
 * Cycles top-level projects in sidebar order with wrap-around, then within the
 * target project selects the most-recently-focused worktree (same recency rule
 * as Cmd+J's empty-query ordering). Pure on purpose: the caller precomputes the
 * project structures so this branching stays unit-testable.
 * Returns the target worktree id, or null when there is nothing to navigate to.
 */
export function selectProjectNavigationTarget(inputs: ProjectNavigationInputs): string | null {
  const {
    orderedProjectKeys,
    worktreesByProjectKey,
    activeProjectKey,
    activeWorktreeId,
    lastVisitedAtByWorktreeId,
    direction
  } = inputs
  const count = orderedProjectKeys.length
  if (count === 0) {
    return null
  }

  const currentIndex = activeProjectKey != null ? orderedProjectKeys.indexOf(activeProjectKey) : -1
  // Why: no active project (or it's off the current list) means the first press
  // should land on a real project — the near end for the chosen direction.
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
    lastVisitedAtByWorktreeId
  })
  // switchableWorktreesForRows excludes the active worktree; for a different
  // target project it isn't a member so every worktree survives. The fallback
  // covers the single-project wrap where the active worktree is the only member.
  return switchableWorktreesForRows[0]?.id ?? projectWorktrees[0]?.id ?? null
}
