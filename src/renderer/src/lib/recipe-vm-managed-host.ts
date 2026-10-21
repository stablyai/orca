import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  getManagedOrcadSshTargetId,
  type ManagedOrcadEnvironmentSummary
} from '../../../shared/managed-orcad-execution-host'

/** The hidden SSH target of the recipe VM whose managed server is `hostId`, or null. */
export function getRecipeVmSshTargetForHost(
  environments: readonly ManagedOrcadEnvironmentSummary[],
  hostId: string | null | undefined
): string | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  const environment = environments.find((entry) => entry.id === host.environmentId)
  const targetId = environment ? getManagedOrcadSshTargetId(environment) : null
  return targetId && isRuntimeOwnedSshTargetId(targetId) ? targetId : null
}
