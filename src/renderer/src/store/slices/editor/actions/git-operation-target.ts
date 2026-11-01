import { toast } from 'sonner'
import type { AppState } from '../../../types'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitRuntimeOperationOptions } from '../types/git-runtime-operation'

export const UNRESOLVED_GIT_HOST_ERROR =
  'The workspace host is unresolved. Refresh the workspace and retry.'

/** The caller's owner transport, else the worktree's own owner; never the focused server. */
export function tryResolveGitOperationTarget(
  state: AppState,
  worktreeId: string,
  options?: Pick<GitRuntimeOperationOptions, 'runtimeTarget'>
): RuntimeClientTarget | null {
  return (
    options?.runtimeTarget ?? runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId })
  )
}

/** {@link tryResolveGitOperationTarget} for user actions: an unresolved host is refused out loud. */
export function resolveGitOperationTarget(
  state: AppState,
  worktreeId: string,
  options?: Pick<GitRuntimeOperationOptions, 'runtimeTarget'>
): RuntimeClientTarget {
  const target = tryResolveGitOperationTarget(state, worktreeId, options)
  if (!target) {
    toast.error(UNRESOLVED_GIT_HOST_ERROR)
    throw new Error(UNRESOLVED_GIT_HOST_ERROR)
  }
  return target
}
