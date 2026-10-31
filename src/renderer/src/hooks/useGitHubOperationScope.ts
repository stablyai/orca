import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isWebClientLocation } from '@/lib/web-client-location'
import { webRuntimeState } from '@/web/preload-api/web-runtime-session'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { resolveGitHubRepoOperationOwner } from '@/lib/github-source-runtime-context'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'

export function useGitHubOperationOwner(args: {
  target?: RuntimeClientTarget | null
  repoId?: string | null
  repoPath?: string | null
  sourceContext?: TaskSourceContext | null
}) {
  const selected = useAppStore(
    useShallow((state) => {
      const requested =
        args.target?.kind === 'local' && isWebClientLocation() && webRuntimeState.activeEnvironment
          ? { kind: 'environment' as const, environmentId: webRuntimeState.activeEnvironment.id }
          : args.target
      const { repo, target } = resolveGitHubRepoOperationOwner(state, {
        ...args,
        target: requested
      })
      const environmentId = target.kind === 'environment' ? target.environmentId : null
      return {
        environmentId,
        issueSourcePreference: repo?.issueSourcePreference,
        scope: JSON.stringify([
          target.kind,
          environmentId,
          args.repoId,
          args.repoPath,
          repo?.id,
          repo?.path,
          repo?.executionHostId,
          repo?.connectionId,
          repo?.ghAccount,
          repo?.issueSourcePreference,
          args.sourceContext,
          environmentId ? getRuntimeEnvironmentRevision(environmentId) : null,
          environmentId ? getRuntimeEnvironmentConnectionGeneration(environmentId) : null
        ])
      }
    })
  )
  return useMemo(
    () => ({
      ...selected,
      target: selected.environmentId
        ? { kind: 'environment' as const, environmentId: selected.environmentId }
        : { kind: 'local' as const }
    }),
    [selected]
  )
}

export function useGitHubOperationScope(
  target: RuntimeClientTarget,
  repoId?: string | null,
  repoPath?: string | null
): string {
  return useGitHubOperationOwner({ target, repoId, repoPath }).scope
}
