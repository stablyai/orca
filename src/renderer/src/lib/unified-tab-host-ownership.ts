import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

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

export function isExecutionHostAliasForWorktree(
  executionHostId: ExecutionHostId,
  worktree: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'>
): boolean {
  const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  return (
    executionHostId === (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) ||
    Boolean(runtimeOwner && executionHostId === toRuntimeExecutionHostId(runtimeOwner))
  )
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
    const runtimeOwner = worktree.runtimeOwnerEnvironmentId?.trim()
    if (isExecutionHostAliasForWorktree(tab.executionHostId, worktree)) {
      return true
    }
    return !worktree.hostId && !runtimeOwner && !ambiguousWorktreeIds.has(worktree.id)
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
