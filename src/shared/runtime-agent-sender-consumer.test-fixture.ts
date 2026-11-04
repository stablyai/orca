import type { RuntimeMobileSessionTabsResult } from './runtime-types'

// Native fixture verifies this boundary without importing desktop-only source into renderer checks.
export type RuntimeAgentSenderPublicationTestModule = {
  verifyHeldSenderPublication(
    consume: (phase: 'immediate' | 'successor', frame: RuntimeMobileSessionTabsResult) => void
  ): Promise<void>
}
