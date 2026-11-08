import { useCallback, useEffect } from 'react'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import { setRuntimeGitStatusUpstreamRefWatch } from '@/runtime/source-control/git/runtime-git-status-client'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'

export function useGitStatusUpstreamRefWatch(args: {
  enabled: boolean
  executionHostId: ExecutionHostId | null | undefined
  worktreeId: string | null
  worktreePath: string | null
}): (status: GitStatusResult) => void {
  const copy = args.worktreeId
    ? resolveWorktreeGitCopyNow(args.worktreeId, args.executionHostId)
    : null
  const owner = copy?.transport
  // Key by primitive identity so new target objects cannot rearm the effect.
  const runtimeEnvironmentId = owner?.kind === 'environment' ? owner.environmentId : null
  const connectionId = copy?.connectionId
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
      scope,
      args.executionHostId,
      args.worktreeId,
      args.worktreePath,
      connectionId,
      runtimeEnvironmentId
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
