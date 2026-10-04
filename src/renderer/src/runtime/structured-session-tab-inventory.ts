import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { refreshLocalStructuredSessionTabs } from './local-structured-session-tabs-sync'
import type { RuntimeClientTarget } from './runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isSessionTabsListAllResult } from './web-session-tabs-sync/tracking'

/**
 * The owning host's current tab inventory. This machine's runtime is read through the local sync,
 * which applies what it lists; a paired host's tabs reach the store through that host's mirror
 * stream, so this only reads them.
 */
export async function readStructuredSessionTabInventory(
  target: RuntimeClientTarget
): Promise<RuntimeMobileSessionTabsResult[]> {
  if (target.kind === 'local') {
    return refreshLocalStructuredSessionTabs(undefined, { authoritative: true })
  }
  const result = await callRuntimeRpc<unknown>(target, 'session.tabs.listAll', {})
  if (!isSessionTabsListAllResult(result)) {
    throw new Error('structured session inventory unavailable')
  }
  return result.snapshots
}
