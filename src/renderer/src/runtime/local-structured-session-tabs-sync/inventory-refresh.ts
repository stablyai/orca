import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { refreshLocalRuntimeCapabilities } from '../local-runtime-capabilities'
import {
  isCurrentLocalStructuredSessionGeneration,
  latchLocalStructuredSessionRestore,
  localStructuredSessionGeneration
} from './inventory-generation-fence'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'

export function restoreLocalStructuredSessionTabsOnce(
  expectedGeneration = localStructuredSessionGeneration()
): Promise<void> {
  return latchLocalStructuredSessionRestore(() =>
    refreshLocalRuntimeCapabilities()
      .then(() => refreshLocalStructuredSessionTabs(expectedGeneration))
      .then(() => undefined)
  )
}

/** Fetch the current host inventory even after the startup restore has settled. */
export function refreshLocalStructuredSessionTabs(
  expectedGeneration = localStructuredSessionGeneration()
): Promise<RuntimeMobileSessionTabsResult[]> {
  return window.api.runtime
    .call({ method: 'session.tabs.listAll', params: {} })
    .then((response) => {
      if (!response.ok) {
        throw new Error('structured session inventory unavailable')
      }
      const result = response.result as { snapshots?: RuntimeMobileSessionTabsResult[] }
      const snapshots = result.snapshots ?? []
      if (isCurrentLocalStructuredSessionGeneration(expectedGeneration)) {
        applyStructuredSessionTabSnapshots(snapshots)
      }
      return snapshots
    })
}
