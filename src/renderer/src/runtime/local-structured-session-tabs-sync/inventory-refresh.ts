import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { refreshLocalRuntimeCapabilities } from '../local-runtime-capabilities'
import { latchLocalStructuredSessionRestore } from './inventory-publication-cursors'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'
import {
  beginStructuredAgentSessionAuthoritativeInventory,
  startStructuredAgentLaunchCancellationCleanup
} from '../../lib/structured-agent-session-launch-cancellation'
import { closeStructuredAgentSession } from '../structured-agent-session-close'

type StructuredSessionInventoryResponse = {
  snapshots?: RuntimeMobileSessionTabsResult[]
  authoritative?: boolean
}

function isStructuredSessionInventoryResponse(
  value: unknown
): value is StructuredSessionInventoryResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('snapshots' in value)) {
    return true
  }
  return value.snapshots === undefined || Array.isArray(value.snapshots)
}

export function restoreLocalStructuredSessionTabsOnce(): Promise<void> {
  // Why concurrent: the capability refresh only seeds the module cache that later launch
  // flows read; the inventory fetch never reads it, so chaining them only paid a second
  // serial IPC round-trip on the startup gate.
  return latchLocalStructuredSessionRestore(() =>
    Promise.all([refreshLocalRuntimeCapabilities(), refreshLocalStructuredSessionTabs()]).then(
      () => undefined
    )
  )
}

/** Fetch the current host inventory even after the startup restore has settled.
 *
 *  `authoritative` is opt-in and belongs to the repair lane alone: the startup restore stays
 *  fenced exactly as before, so nothing about first paint changes. */
export function refreshLocalStructuredSessionTabs(
  options: { authoritative?: boolean } = {}
): Promise<RuntimeMobileSessionTabsResult[]> {
  // Capture request order before IPC: a reply that began before a close cannot retire its fence.
  const authoritativeInventory = beginStructuredAgentSessionAuthoritativeInventory()
  // An explicit authoritative request can start cleanup before IPC. Otherwise wait until the
  // host labels the response authoritative so failed/retrying ordinary refreshes do not churn RPCs.
  if (options.authoritative) {
    startStructuredAgentLaunchCancellationCleanup((sessionId) =>
      closeStructuredAgentSession({ kind: 'local' }, sessionId)
    )
  }
  return window.api.runtime
    .call({ method: 'session.tabs.listAll', params: {} })
    .then((response) => {
      if (!response.ok) {
        throw new Error('structured session inventory unavailable')
      }
      const result = isStructuredSessionInventoryResponse(response.result) ? response.result : {}
      const snapshots = result.snapshots ?? []
      if (options.authoritative === true || result.authoritative === true) {
        startStructuredAgentLaunchCancellationCleanup((sessionId) =>
          closeStructuredAgentSession({ kind: 'local' }, sessionId)
        )
      }
      applyStructuredSessionTabSnapshots(snapshots, undefined, {
        ...options,
        authoritative: options.authoritative === true || result.authoritative === true,
        authoritativeInventory
      })
      return snapshots
    })
}
