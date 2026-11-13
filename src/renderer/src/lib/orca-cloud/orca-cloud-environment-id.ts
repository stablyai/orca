import { useAppStore } from '@/store/index'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { parseExecutionHostId } from '../../../../shared/execution-host'

/** True when this runtime environment is an Orca Cloud sandbox (never guessed from its name alone). */
export function isOrcaCloudEnvironmentId(environmentId: string): boolean {
  const environment = useAppStore
    .getState()
    .runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
}

/**
 * FAIL-CLOSED (#568) for agent launches: the catalog flag first, then main's own records, because a
 * fresh pairing's `orcaCloudPaired` can reach this store after its first worktree does.
 */
export async function isOrcaCloudEnvironmentForLaunch(environmentId: string): Promise<boolean> {
  if (isOrcaCloudEnvironmentId(environmentId)) {
    return true
  }
  const answer = await window.api.orcaCloudAgents
    ?.isCloudEnvironment?.({ runtimeEnvironmentId: environmentId })
    .catch(() => false)
  return answer === true
}

/** True when this execution host is an Orca Cloud sandbox's runtime (`runtime:<environment>`). */
export function isOrcaCloudExecutionHostId(hostId: string | null | undefined): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && isOrcaCloudEnvironmentId(parsed.environmentId)
}
