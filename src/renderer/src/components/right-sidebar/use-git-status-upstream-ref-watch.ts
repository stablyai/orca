import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { setRuntimeGitStatusUpstreamRefWatch } from '@/runtime/runtime-git-status-client'
import type { GitStatusResult } from '../../../../shared/git-status-types'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { getWorktreeGitOwnerTarget } from './worktree-git-owner-target'

export function useGitStatusUpstreamRefWatch(args: {
  enabled: boolean
  executionHostId: string | null | undefined
  worktreeId: string | null
  worktreePath: string | null
}): (status: GitStatusResult) => void {
  const owner = getWorktreeGitOwnerTarget(args.worktreeId)
  // Key by primitive identity so new target objects cannot rearm the effect.
  const runtimeEnvironmentId = owner?.kind === 'environment' ? owner.environmentId : null
  const connectionId = args.worktreeId ? (getConnectionId(args.worktreeId) ?? undefined) : undefined
  const scope =
    args.enabled && args.executionHostId && owner
      ? `${args.executionHostId}\0${runtimeEnvironmentId}\0${args.worktreeId}\0${args.worktreePath}`
      : null

  const publish = useCallback(
    (status: GitStatusResult): void => {
      if (!scope || !args.executionHostId || !args.worktreeId || !args.worktreePath) {
        return
      }
      const upstreamName = status.upstreamStatus?.hasUpstream
        ? status.upstreamStatus.upstreamName
        : undefined
      void setRuntimeGitStatusUpstreamRefWatch(
        {
          target: runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
          worktreeId: args.worktreeId,
          worktreePath: args.worktreePath,
          connectionId
        },
        {
          executionHostId: args.executionHostId,
          ...(status.branch ? { branch: status.branch } : {}),
          ...(upstreamName ? { upstreamName } : {})
        }
      ).catch(() => {})
    },
    [
      args.executionHostId,
      args.worktreeId,
      args.worktreePath,
      connectionId,
      runtimeEnvironmentId,
      scope
    ]
  )

  useEffect(() => {
    if (!scope || !args.executionHostId || !args.worktreeId || !args.worktreePath) {
      return
    }
    const executionHostId = args.executionHostId
    const worktreeId = args.worktreeId
    const worktreePath = args.worktreePath
    return () => {
      void setRuntimeGitStatusUpstreamRefWatch(
        {
          target: runtimeTargetForOwnerEnvironment(runtimeEnvironmentId),
          worktreeId,
          worktreePath,
          connectionId
        },
        { executionHostId }
      ).catch(() => {})
    }
  }, [
    args.executionHostId,
    args.worktreeId,
    args.worktreePath,
    connectionId,
    runtimeEnvironmentId,
    scope
  ])

  return publish
}
