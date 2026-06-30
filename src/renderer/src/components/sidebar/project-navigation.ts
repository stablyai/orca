import type { Worktree } from '../../../../shared/types'
import { orderEmptyQueryWorktrees } from '@/lib/order-empty-query-worktrees'

export type ProjectNavigationDirection = 'up' | 'down'

export type ProjectNavigationOrder = {
  /** Top-level project identity keys in sidebar order, deduped. */
  orderedProjectKeys: string[]
  /** Worktrees grouped by their top-level project key, in sidebar order. */
  worktreesByProjectKey: Map<string, Worktree[]>
  /** Reverse lookup: which project a worktree belongs to. */
  projectKeyByWorktreeId: Map<string, string>
}

/**
 * Collapse an ordered worktree list into its top-level projects. The caller
 * passes worktrees in sidebar order (pinned duplicates already removed so the
 * cycle order follows the visible section headers) and a projectKeyOf that maps
 * a worktree to its top-level project key (project group, or repo when
 * ungrouped). Order is first-appearance; worktrees with no project key are
 * skipped. Pure so the derivation stays unit-testable.
 */
export function buildProjectNavigationOrder(
  orderedWorktrees: readonly Worktree[],
  projectKeyOf: (worktree: Worktree) => string | null
): ProjectNavigationOrder {
  const orderedProjectKeys: string[] = []
  const seenProjectKeys = new Set<string>()
  const worktreesByProjectKey = new Map<string, Worktree[]>()
  const projectKeyByWorktreeId = new Map<string, string>()
  for (const worktree of orderedWorktrees) {
    if (projectKeyByWorktreeId.has(worktree.id)) {
      continue
    }
    const projectKey = projectKeyOf(worktree)
    if (!projectKey) {
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
