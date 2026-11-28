import { EMULATOR_OPENING_PREFERENCES_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/emulator-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'

export async function supportsEmulatorOpeningPreferences(
  target: RuntimeClientTarget = { kind: 'local' }
): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(
      target.environmentId,
      EMULATOR_OPENING_PREFERENCES_CAPABILITY
    ).catch(() => false)
  }
  return (
    (await ensureLocalRuntimeCapabilities())?.includes(EMULATOR_OPENING_PREFERENCES_CAPABILITY) ??
    false
  )
}
