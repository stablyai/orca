import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'

export function findAmbiguousWorktreeIds(
  worktrees: readonly Pick<Worktree, 'id'>[]
): ReadonlySet<string> {
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const worktree of worktrees) {
    if (seen.has(worktree.id)) {
      ambiguous.add(worktree.id)
    }
    seen.add(worktree.id)
  }
  return ambiguous
}

export function isUnifiedTabOwnedByWorktree(
  tab: Pick<Tab, 'executionHostId' | 'worktreeId'> | undefined,
  worktree: Pick<Worktree, 'hostId' | 'id' | 'runtimeOwnerEnvironmentId'>,
  ambiguousWorktreeIds: ReadonlySet<string>
): boolean {
  if (!tab || tab.worktreeId !== worktree.id) {
    return false
  }
  if (tab.executionHostId) {
    return isExecutionHostAliasForWorktree(tab.executionHostId, worktree)
  }
  return !ambiguousWorktreeIds.has(worktree.id)
}

export function getUnifiedTabPaletteExecutionHostId(
  tab: Pick<Tab, 'executionHostId'> | undefined,
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): ExecutionHostId | undefined {
  if (!tab) {
    return worktree.hostId
  }
  if (tab.executionHostId && isExecutionHostAliasForWorktree(tab.executionHostId, worktree)) {
    return tab.executionHostId
  }
  return worktree.hostId
}
