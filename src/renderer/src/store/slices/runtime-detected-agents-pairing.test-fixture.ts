import { createStore } from 'zustand/vanilla'
import type { AppState } from '../types'
import { getDefaultSettings } from '../../../../shared/constants'
import { withSessionSourceTestWrites } from '@/lib/test-support/session-source-test-store'
import { createRuntimeDetectedAgentsSlice } from './runtime-detected-agents'
import { createRuntimeAgentOwnerTestState } from './runtime-detected-agents.test-fixture'
import { createRuntimeStatusSlice } from './runtime-status'

export function createRuntimeDetectedAgentsPairingTestStore() {
  return createStore<AppState>()(
    withSessionSourceTestWrites(
      (...args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this pairing fixture supplies the runtime slices and owner policy exercised by detection.
        ({
          ...createRuntimeStatusSlice(...args),
          ...createRuntimeDetectedAgentsSlice(...args),
          ...createRuntimeAgentOwnerTestState(),
          settings: getDefaultSettings('/test-home'),
          clientHostedBrowserCloseIntentsByEnvironment: {},
          clearClientHostedBrowserCloseIntents: () => {
            throw new Error('Agent-detection pairing must not replay browser close intents')
          }
        }) as unknown as AppState
    )
  )
}
