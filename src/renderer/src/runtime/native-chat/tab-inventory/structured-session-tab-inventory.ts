import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  refreshLocalStructuredSessionTabs,
  refreshLocalStructuredSessionWorktreeTabs
} from '../../local-structured-session-tabs-sync/inventory-refresh'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { isSessionTabsListAllResult } from '../../web-session-tabs-sync/tracking/tracking'

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

/** One worktree's tabs on the owning host, without reading every other worktree; an older paired
 *  host without the scoped list answers from its whole inventory. */
export async function readStructuredSessionWorktreeTabs(
  target: RuntimeClientTarget,
  worktreeId: string,
  worktreeSelector: string
): Promise<RuntimeMobileSessionTabsResult | undefined> {
  if (target.kind === 'local') {
    const snapshot = await refreshLocalStructuredSessionWorktreeTabs(worktreeId)
    if (!snapshot) {
      throw new Error('structured session inventory unavailable')
    }
    return snapshot
  }
  try {
    const result = await callRuntimeRpc<unknown>(target, 'session.tabs.list', {
      worktree: worktreeSelector
    })
    if (!isSessionTabsListResult(result)) {
      throw new Error('structured session inventory unavailable')
    }
    return result
  } catch (error) {
    if (!hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw error
    }
    const snapshots = await readStructuredSessionTabInventory(target)
    return snapshots.find((snapshot) => snapshot.worktree === worktreeId)
  }
}

function isSessionTabsListResult(value: unknown): value is RuntimeMobileSessionTabsResult {
  return typeof value === 'object' && value !== null && 'tabs' in value && Array.isArray(value.tabs)
}
