import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import { callRuntimeEnvelope, getRemoteRuntimeStatus } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export function createWebRuntimeApi(): NonNullable<Partial<PreloadApi>['runtime']> {
  return {
    syncWindowGraph: async (_graph: RuntimeSyncWindowGraph) => getRemoteRuntimeStatus(),
    getStatus: () => getRemoteRuntimeStatus(),
    call: ({ method, params }) => callRuntimeEnvelope(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onNativeChatLaunchDraftResolved: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe
  }
}
