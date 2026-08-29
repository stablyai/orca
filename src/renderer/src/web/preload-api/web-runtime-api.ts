import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-types'
import { callRuntimeEnvelope, getRemoteRuntimeStatus } from './web-runtime-calls'
import {
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  requireActiveEnvironment
} from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createWebRuntimeApi(): NonNullable<Partial<PreloadApi>['runtime']> {
  return {
    syncWindowGraph: async (_graph: RuntimeSyncWindowGraph) => getRemoteRuntimeStatus(),
    getStatus: () => getRemoteRuntimeStatus(),
    call: ({ method, params }) => callRuntimeEnvelope(method, params),
    subscribe: async ({ method, params }, callback) => {
      const environment = requireActiveEnvironment()
      const subscription = await getClientForEnvironment(environment).subscribe(method, params, {
        onResponse: callback
      })
      if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
        subscription.unsubscribe()
        throw new Error('runtime_manually_disconnected')
      }
      return subscription
    },
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    // Why: the web client never hosts a guest webview, so it has nothing to keep paintable.
    getBrowserRemoteViewerPages: () => Promise.resolve([]),
    // Why: client-hosted rows describe pages a paired desktop renders for a host; the web client
    // is never that host.
    getClientHostedBrowserRows: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onNativeChatLaunchDraftResolved: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe,
    onBrowserRemoteViewersChanged: () => noopUnsubscribe,
    onClientHostedBrowserRowsChanged: () => noopUnsubscribe
  }
}
