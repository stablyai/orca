import { useCloudRecoveryContext } from '@/lib/orca-cloud/use-cloud-recovery-context'
import { useIsWorktreeGoingToSleep, useIsWorktreeSleepViewHeld } from '@/lib/worktree-sleep-view'
import { useAppStore } from '@/store/index'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { Repo } from '../../../../shared/repo-types'

/**
 * An Orca Cloud workspace whose setup script can't be inspected right now: asleep or waking
 * (RA-12, JA-15), going to sleep, or kept on screen read-only after Sleep (RA-13b). The
 * setup-script card waits instead of showing "Couldn't verify this repo's setup script" with Retry.
 */
export function useSetupScriptAsleepCloud(worktreeId: string | null | undefined): boolean {
  const context = useCloudRecoveryContext(worktreeId)
  const asleep = context?.asleep === true || context?.waking === true
  const goingToSleep = useIsWorktreeGoingToSleep(worktreeId ?? null)
  const viewOnly = useIsWorktreeSleepViewHeld(worktreeId ?? null)
  return asleep || goingToSleep || viewOnly
}

/**
 * The project copy lives on an Orca Cloud sandbox (`runtime:<cloud environment>`). Orca Cloud never
 * shows this nudge (PC-7), and the check can't reach an archived or asleep sandbox: after archiving,
 * the project stays selected with no workspace, which showed "Couldn't verify" with Retry (N-28).
 */
export function useIsCloudRepoHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null
): boolean {
  const host = parseExecutionHostId(repo ? getRepoExecutionHostId(repo) : null)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  return useAppStore((s) => {
    if (!environmentId) {
      return false
    }
    const environment = s.runtimeEnvironments?.find((entry) => entry.id === environmentId)
    return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
  })
}
