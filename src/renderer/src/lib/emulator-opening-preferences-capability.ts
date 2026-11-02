import { EMULATOR_OPENING_PREFERENCES_CAPABILITY } from '../../../shared/emulator-runtime-capabilities'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
export async function supportsEmulatorOpeningPreferences(): Promise<boolean> {
  return (
    (await ensureLocalRuntimeCapabilities())?.includes(EMULATOR_OPENING_PREFERENCES_CAPABILITY) ??
    false
  )
}
