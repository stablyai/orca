import type { RuntimeCapability } from '../../../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { ensureLocalRuntimeCapabilities } from '../../hosts/capabilities/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-capability-proof'

/** An unreachable or unprobed host counts as unsupported. */
export async function runtimeTargetSupportsCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): Promise<boolean> {
  return target.kind === 'environment'
    ? await runtimeEnvironmentSupportsCapability(target.environmentId, capability).catch(
        () => false
      )
    : (await ensureLocalRuntimeCapabilities())?.includes(capability) === true
}
