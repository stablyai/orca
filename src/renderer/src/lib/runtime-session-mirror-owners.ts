import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

function addRuntimeExecutionHost(ids: Set<string>, hostId: string | null | undefined): void {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'runtime') {
    ids.add(parsed.environmentId)
  }
}

function addWorktreeOwner(
  ids: Set<string>,
  worktree: { hostId?: string; runtimeOwnerEnvironmentId?: string }
): void {
  const projectedOwner = worktree.runtimeOwnerEnvironmentId?.trim()
  if (projectedOwner) {
    ids.add(projectedOwner)
    return
  }
  addRuntimeExecutionHost(ids, worktree.hostId)
}

export function getRuntimeSessionMirrorEnvironmentIds(state: WorktreeRuntimeOwnerState): string[] {
  const ids = new Set<string>()
  const activeRuntimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  if (activeRuntimeEnvironmentId) {
    ids.add(activeRuntimeEnvironmentId)
  }
  for (const repo of state.repos ?? []) {
    addRuntimeExecutionHost(ids, getRepoExecutionHostId(repo))
  }
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      addWorktreeOwner(ids, worktree)
    }
  }
  for (const result of Object.values(state.detectedWorktreesByRepo ?? {})) {
    for (const worktree of result.worktrees) {
      addWorktreeOwner(ids, worktree)
    }
  }
  for (const group of state.projectGroups ?? []) {
    addRuntimeExecutionHost(ids, group.executionHostId)
  }
  for (const hostId of Object.values(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
    addRuntimeExecutionHost(ids, hostId)
  }
  return [...ids].sort()
}
