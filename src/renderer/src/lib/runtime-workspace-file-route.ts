import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { findRuntimeWorkspaceFileOwner } from '../../../shared/runtime-workspace-file-owner'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  getExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-route'
import { resolveExactWorktreeRoute } from './worktree-owner-route'

export type RuntimeWorkspaceFileRoute = {
  worktreeId: string
  relativePath: string
  executionHostId: ExecutionHostId
}

function workspaceMatchesExecutionHost(
  state: AppState,
  workspaceId: string,
  executionHostId: ExecutionHostId
): boolean {
  const parsedHost = parseExecutionHostId(executionHostId)
  if (parsedHost?.kind === 'runtime') {
    return (
      getExplicitRuntimeEnvironmentIdForWorktree(state, workspaceId) === parsedHost.environmentId
    )
  }
  const explicit = resolveExplicitWorktreeOperationRouteResult(state, workspaceId)
  if (explicit.kind === 'resolved') {
    return explicit.route.executionHostId === executionHostId
  }
  return (
    executionHostId === 'local' && getExecutionHostIdForWorktree(state, workspaceId) === 'local'
  )
}

function worktreeMatchesExecutionHost(
  state: AppState,
  worktree: AppState['worktreesByRepo'][string][number],
  executionHostId: ExecutionHostId,
  hasDuplicateId: boolean
): boolean {
  const route = resolveExactWorktreeRoute(state, worktree)
  if (route.kind === 'resolved') {
    const parsedHost = parseExecutionHostId(executionHostId)
    return parsedHost?.kind === 'runtime'
      ? route.route.runtimeEnvironmentId === parsedHost.environmentId
      : route.route.executionHostId === executionHostId
  }
  // Why: hostless legacy rows are safe only when their worktree identity is unique.
  return !hasDuplicateId && workspaceMatchesExecutionHost(state, worktree.id, executionHostId)
}

export function findWorkspaceFileRoute(
  state: AppState,
  executionHostId: ExecutionHostId,
  absolutePath: string
): RuntimeWorkspaceFileRoute | null {
  const worktrees = Object.values(state.worktreesByRepo).flat()
  const idCounts = new Map<string, number>()
  for (const worktree of worktrees) {
    idCounts.set(worktree.id, (idCounts.get(worktree.id) ?? 0) + 1)
  }
  const matchingWorktrees = new Map<string, (typeof worktrees)[number]>()
  for (const worktree of worktrees) {
    if (
      worktreeMatchesExecutionHost(
        state,
        worktree,
        executionHostId,
        (idCounts.get(worktree.id) ?? 0) > 1
      )
    ) {
      matchingWorktrees.set(worktree.id, worktree)
    }
  }
  const roots = Array.from(matchingWorktrees.values()).map((worktree) => ({
    workspaceId: worktree.id,
    rootPath: worktree.path,
    executionHostId
  }))
  for (const workspace of state.folderWorkspaces) {
    const workspaceId = folderWorkspaceKey(workspace.id)
    if (workspaceMatchesExecutionHost(state, workspaceId, executionHostId)) {
      roots.push({ workspaceId, rootPath: workspace.folderPath, executionHostId })
    }
  }

  const owner = findRuntimeWorkspaceFileOwner(roots, absolutePath, executionHostId)
  return owner && owner.relativePath !== ''
    ? { worktreeId: owner.workspaceId, relativePath: owner.relativePath, executionHostId }
    : null
}

export function findRuntimeWorkspaceFileRoute(
  state: AppState,
  runtimeEnvironmentId: string,
  absolutePath: string
): RuntimeWorkspaceFileRoute | null {
  const ownerId = runtimeEnvironmentId.trim()
  if (!ownerId) {
    return null
  }
  const executionHostId = toRuntimeExecutionHostId(ownerId)
  return findWorkspaceFileRoute(state, executionHostId, absolutePath)
}
