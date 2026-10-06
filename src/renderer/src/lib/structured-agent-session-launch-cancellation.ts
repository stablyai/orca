import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  markStructuredAgentLaunchCancelledPersisted,
  readStructuredAgentLaunchCancellationTombstoneSessionIds,
  retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted,
  retireStructuredAgentLaunchCancellationTombstonePersisted
} from './structured-agent-session-launch-persistence'

type CancellationRetirement = {
  retireAfterInventory: number | null
  cleanupStarted: boolean
  restored: boolean
}

const cancellationRetirementBySessionId = new Map<string, CancellationRetirement>()
let authoritativeInventorySequence = 0

function restoreCancellationRetirementFences(): void {
  for (const sessionId of readStructuredAgentLaunchCancellationTombstoneSessionIds()) {
    if (!cancellationRetirementBySessionId.has(sessionId)) {
      cancellationRetirementBySessionId.set(sessionId, {
        // A tombstone loaded after reload has no proof that an old create settled.
        retireAfterInventory: null,
        cleanupStarted: false,
        restored: true
      })
    }
  }
}

export function resetStructuredAgentLaunchCancellationForTests(): void {
  cancellationRetirementBySessionId.clear()
  authoritativeInventorySequence = 0
}

/** Captured when an inventory request starts so a cancellation can reject older replies. */
export function beginStructuredAgentSessionAuthoritativeInventory(): number {
  restoreCancellationRetirementFences()
  authoritativeInventorySequence += 1
  return authoritativeInventorySequence
}

/** Claims `executionHostId`'s restored tombstones for best-effort cleanup on that host before
 *  its authoritative census. */
export function claimStructuredAgentLaunchCancellationCleanups(
  executionHostId: ExecutionHostId
): readonly string[] {
  restoreCancellationRetirementFences()
  const owned = new Set(readStructuredAgentLaunchCancellationTombstoneSessionIds(executionHostId))
  const claimed: string[] = []
  for (const [sessionId, retirement] of cancellationRetirementBySessionId) {
    if (owned.has(sessionId) && retirement.restored && !retirement.cleanupStarted) {
      retirement.cleanupStarted = true
      claimed.push(sessionId)
    }
  }
  return claimed
}

export function settleStructuredAgentLaunchCancellationCleanup(
  sessionId: string,
  succeeded: boolean
): void {
  const retirement = cancellationRetirementBySessionId.get(sessionId)
  if (!retirement) {
    return
  }
  if (!succeeded) {
    retirement.cleanupStarted = false
    return
  }
  retirement.restored = false
  // Inventories already in flight may have observed the pre-cleanup state.
  retirement.retireAfterInventory = authoritativeInventorySequence + 1
}

export function startStructuredAgentLaunchCancellationCleanup(
  executionHostId: ExecutionHostId,
  cleanup: (sessionId: string) => Promise<unknown>
): void {
  for (const sessionId of claimStructuredAgentLaunchCancellationCleanups(executionHostId)) {
    void cleanup(sessionId).then(
      () => settleStructuredAgentLaunchCancellationCleanup(sessionId, true),
      (error: unknown) => {
        settleStructuredAgentLaunchCancellationCleanup(sessionId, false)
        console.warn('[structured-agent-launch] restored cancellation cleanup failed', error)
      }
    )
  }
}

export function markStructuredAgentLaunchCancellation(
  sessionId: string,
  executionHostId: ExecutionHostId,
  alreadyCancelled: boolean,
  launchPromise?: Promise<unknown>
): void {
  markStructuredAgentLaunchCancelledPersisted(sessionId, executionHostId)
  if (launchPromise) {
    const retirement: CancellationRetirement = {
      retireAfterInventory: null,
      cleanupStarted: false,
      restored: false
    }
    cancellationRetirementBySessionId.set(sessionId, retirement)
    const armRetirement = (): void => {
      if (cancellationRetirementBySessionId.get(sessionId) === retirement) {
        // Inventories started before the create settled cannot prove that it will not publish.
        retirement.retireAfterInventory = authoritativeInventorySequence + 1
      }
    }
    void launchPromise.then(armRetirement, armRetirement)
  } else if (!alreadyCancelled) {
    // No in-memory launch remains; the user close already issued best-effort host cleanup.
    cancellationRetirementBySessionId.set(sessionId, {
      retireAfterInventory: authoritativeInventorySequence + 1,
      cleanupStarted: false,
      restored: false
    })
  }
}

export function retireStructuredAgentLaunchCancellation(sessionId: string): void {
  retireStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  cancellationRetirementBySessionId.delete(sessionId)
}

/** `publishedSessionIds` is `executionHostId`'s own authoritative inventory. */
export function retireAbsentStructuredAgentLaunchCancellations(
  publishedSessionIds: ReadonlySet<string>,
  authoritativeInventory: number,
  executionHostId: ExecutionHostId
): boolean {
  restoreCancellationRetirementFences()
  const retainedSessionIds = new Set(publishedSessionIds)
  for (const [sessionId, retirement] of cancellationRetirementBySessionId) {
    if (
      retirement.retireAfterInventory === null ||
      authoritativeInventory < retirement.retireAfterInventory
    ) {
      retainedSessionIds.add(sessionId)
    }
  }
  const changed = retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(
    retainedSessionIds,
    executionHostId
  )
  if (changed) {
    for (const sessionId of cancellationRetirementBySessionId.keys()) {
      if (!hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)) {
        cancellationRetirementBySessionId.delete(sessionId)
      }
    }
  }
  return changed
}
