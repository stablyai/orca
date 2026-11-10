import { useMemo } from 'react'
import { useAppStore } from '../../../store/index'
import { getExecutionHostIdForWorktree } from '../../../lib/workspace/ownership/worktree-runtime-owner'
import { getRuntimeTargetForFileOwner } from '../../../lib/file-owner-runtime-target'
import { getActiveWorkspaceOwnerTarget } from '../../../lib/resolved-worktree-execution-host'
import {
  runtimeRpcTargetForAuthorityKey,
  runtimeTargetForOwnerEnvironment,
  runtimeTargetEnvironmentId
} from './runtime-client-target'
import '../../provider-accounts/ownership/wsl-host-account-owner'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** Target the workspace owner rather than the focused host or port scans hit the wrong machine. Direct-SSH owners return null. */
export function useWorktreeRuntimeTarget(
  worktreeId: string | null | undefined
): RuntimeClientTarget | null {
  const executionHostId = useAppStore((state) => getExecutionHostIdForWorktree(state, worktreeId))
  return useMemo(() => runtimeRpcTargetForAuthorityKey(executionHostId), [executionHostId])
}

/**
 * Transport to an open file's owner (see {@link getRuntimeTargetForFileOwner}), stable across
 * renders; `null` while rows disagree.
 */
export function useFileOwnerRuntimeTarget(
  worktreeId: string | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): RuntimeClientTarget | null {
  // Fresh target objects would rerender on every store write; select a stable string.
  const ownerKey = useAppStore((state) => {
    const target = getRuntimeTargetForFileOwner(state, worktreeId, runtimeEnvironmentId)
    return target ? (target.kind === 'environment' ? target.environmentId : '') : null
  })
  return useMemo(
    () => (ownerKey === null ? null : runtimeTargetForOwnerEnvironment(ownerKey || null)),
    [ownerKey]
  )
}

/** {@link getActiveWorkspaceOwnerTarget}, else `fallback`; stable across renders. */
export function useActiveWorkspaceOwnerTarget(fallback: RuntimeClientTarget): RuntimeClientTarget {
  // Fresh target objects would rerender on every store write; select a stable string.
  const ownerKey = useAppStore((state) => {
    const target = getActiveWorkspaceOwnerTarget(state)
    return target ? (runtimeTargetEnvironmentId(target) ?? '') : null
  })
  const environmentId = ownerKey === null ? runtimeTargetEnvironmentId(fallback) : ownerKey || null
  return useMemo(() => runtimeTargetForOwnerEnvironment(environmentId), [environmentId])
}
