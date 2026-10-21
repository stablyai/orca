import { useMemo } from 'react'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { UNRESOLVED_GIT_HOST_ERROR } from '@/store/slices/editor/actions/git-operation-target'

function ownerTargetFor(
  state: AppState,
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  return worktreeId ? runtimeTargetForWorkspaceOwner(state, { workspaceId: worktreeId }) : null
}

/**
 * Transport to the worktree's owner for right-sidebar git work, or `null` when its rows name none
 * or disagree. Never the focused server, which can change while a poll is in flight.
 */
export function getWorktreeGitOwnerTarget(
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  return ownerTargetFor(useAppStore.getState(), worktreeId)
}

/** {@link getWorktreeGitOwnerTarget} as a hook with a stable identity per owner. */
export function useWorktreeGitOwnerTarget(
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  // Why a key: the resolver returns a fresh object per call, which would re-render every write.
  const ownerKey = useAppStore((state) => {
    const target = ownerTargetFor(state, worktreeId)
    return target ? (target.kind === 'environment' ? `env:${target.environmentId}` : 'local') : null
  })
  return useMemo(
    () =>
      ownerKey === null
        ? null
        : runtimeTargetForOwnerEnvironment(ownerKey === 'local' ? null : ownerKey.slice(4)),
    [ownerKey]
  )
}

/** The owner transport for a git call, or the unresolved-host refusal the caller already surfaces. */
export function requireGitOwnerTarget(target: RuntimeClientTarget | null): RuntimeClientTarget {
  if (!target) {
    throw new Error(UNRESOLVED_GIT_HOST_ERROR)
  }
  return target
}
