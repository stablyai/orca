import { EMULATOR_OPENING_PREFERENCES_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/emulator-runtime-capabilities'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { ensureRuntimeEnvironmentCompatible } from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export async function supportsEmulatorOpeningPreferences(
  target: RuntimeClientTarget = { kind: 'local' }
): Promise<boolean> {
  const capabilities =
    target.kind === 'local'
      ? await ensureLocalRuntimeCapabilities()
      : (await ensureRuntimeEnvironmentCompatible(target.environmentId))?.capabilities
  return capabilities?.includes(EMULATOR_OPENING_PREFERENCES_CAPABILITY) ?? false
}
