import { useAppStore } from '@/store/index'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

/** True when this runtime environment is an Orca Cloud sandbox (never guessed from its name alone). */
export function isOrcaCloudEnvironmentId(environmentId: string): boolean {
  const environment = useAppStore
    .getState()
    .runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
}
