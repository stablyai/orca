import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { refreshLocalRuntimeCapabilities } from '../local-runtime-capabilities'
import {
  isCurrentLocalStructuredSessionGeneration,
  latchLocalStructuredSessionRestore,
  localStructuredSessionGeneration
} from './inventory-generation-fence'
import { applyStructuredSessionTabSnapshots } from './snapshot-apply'
import {
  beginStructuredAgentSessionAuthoritativeInventory,
  startStructuredAgentLaunchCancellationCleanup
} from '../../lib/launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { closeStructuredAgentSession } from '../structured-agent-session-close'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../runtime-worktree-selector'

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

export function restoreLocalStructuredSessionTabsOnce(
  expectedGeneration = localStructuredSessionGeneration()
): Promise<void> {
  // Capability refresh only seeds later launch routing; inventory does not read it, so parallelize their startup IPC round trips.
  return latchLocalStructuredSessionRestore(() =>
    Promise.all([
      refreshLocalRuntimeCapabilities(),
      refreshLocalStructuredSessionTabs(expectedGeneration)
    ]).then(() => undefined)
  )
}

/** Fetch the current host inventory even after the startup restore has settled.
 *
 *  `authoritative` is opt-in and belongs to the repair lane alone: the startup restore stays
 *  fenced exactly as before, so nothing about first paint changes. */
export function refreshLocalStructuredSessionTabs(
  expectedGeneration = localStructuredSessionGeneration(),
  options: { authoritative?: boolean } = {}
): Promise<RuntimeMobileSessionTabsResult[]> {
  // Capture request order before IPC: a reply that began before a close cannot retire its fence.
  const authoritativeInventory = beginStructuredAgentSessionAuthoritativeInventory()
  // Explicit authority can start cleanup before IPC; ordinary refreshes wait for host affirmation or failed retries churn RPCs.
  if (options.authoritative) {
    startStructuredAgentLaunchCancellationCleanup(LOCAL_EXECUTION_HOST_ID, (sessionId) =>
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
        startStructuredAgentLaunchCancellationCleanup(LOCAL_EXECUTION_HOST_ID, (sessionId) =>
          closeStructuredAgentSession({ kind: 'local' }, sessionId)
        )
      }
      if (isCurrentLocalStructuredSessionGeneration(expectedGeneration)) {
        applyStructuredSessionTabSnapshots(snapshots, undefined, {
          ...options,
          authoritative: options.authoritative === true || result.authoritative === true,
          authoritativeInventory
        })
      }
      return snapshots
    })
}

/** Re-reads one worktree from this machine's host. `reacceptCurrentVersion` is for a window that
 *  removed a chat before the host answered its close: nothing republishes an unchanged list. */
export async function refreshLocalStructuredSessionWorktreeTabs(
  worktreeId: string,
  options: { reacceptCurrentVersion?: boolean } = {}
): Promise<RuntimeMobileSessionTabsResult | null> {
  // Structured chat can be switched off mid-call, which wipes the mirror; a late answer must not re-seed it.
  const expectedGeneration = localStructuredSessionGeneration()
  const snapshot = await callRuntimeRpc<RuntimeMobileSessionTabsResult>(
    { kind: 'local' },
    'session.tabs.list',
    { worktree: toRuntimeWorktreeSelector(worktreeId) }
  )
  if (!isCurrentLocalStructuredSessionGeneration(expectedGeneration)) {
    return null
  }
  applyStructuredSessionTabSnapshots([snapshot], undefined, options)
  return snapshot
}
