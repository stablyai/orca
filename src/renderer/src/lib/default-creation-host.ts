import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

/**
 * The "Default host for new projects" setting. Only a creation flow with no source row reads it;
 * everything else routes by the resource's owner.
 */
export function defaultCreationHost(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RuntimeClientTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}
