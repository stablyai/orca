import { projectRuntimeEnvironmentCatalog } from '../../../../shared/runtime-environment-catalog-projection'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

export const LOCAL_RUNTIME_VALUE = '__local__'
export const NO_RUNTIME_VALUE = '__none__'

export function runtimeEnvironmentSelectionOptions(
  environments: readonly PublicKnownRuntimeEnvironment[],
  activeEnvironmentId: string
): PublicKnownRuntimeEnvironment[] {
  const options = projectRuntimeEnvironmentCatalog(environments).map((entry) => entry.environment)
  const active = environments.find((environment) => environment.id === activeEnvironmentId)
  // Preserve the selected grant until an explicit switch, even after catalog activation.
  if (active && !options.some((environment) => environment.id === active.id)) {
    options.push(active)
  }
  return options
}
