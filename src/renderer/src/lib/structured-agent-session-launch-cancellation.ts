import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  markStructuredAgentLaunchCancelledPersisted,
  readStructuredAgentLaunchCancellationTombstoneSessionIds,
  retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted,
  retireStructuredAgentLaunchCancellationTombstonePersisted,
  structuredAgentLaunchCancellationBelongsTo
} from './structured-agent-session-launch-persistence'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

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

/** Claims restored tombstones for best-effort host cleanup before an authoritative census. */
export function claimStructuredAgentLaunchCancellationCleanups(
  target: RuntimeClientTarget = { kind: 'local' }
): readonly string[] {
  restoreCancellationRetirementFences()
  const claimed: string[] = []
  for (const [sessionId, retirement] of cancellationRetirementBySessionId) {
    if (
      retirement.restored &&
      !retirement.cleanupStarted &&
      structuredAgentLaunchCancellationBelongsTo(sessionId, target)
    ) {
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
  cleanup: (sessionId: string) => Promise<unknown>,
  target: RuntimeClientTarget = { kind: 'local' }
): void {
  for (const sessionId of claimStructuredAgentLaunchCancellationCleanups(target)) {
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
  alreadyCancelled: boolean,
  launchPromise?: Promise<unknown>,
  target?: RuntimeClientTarget
): void {
  markStructuredAgentLaunchCancelledPersisted(sessionId, target)
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

export function retireAbsentStructuredAgentLaunchCancellations(
  publishedSessionIds: ReadonlySet<string>,
  authoritativeInventory: number,
  target: RuntimeClientTarget = { kind: 'local' }
): boolean {
  restoreCancellationRetirementFences()
  const retainedSessionIds = new Set(publishedSessionIds)
  for (const [sessionId, retirement] of cancellationRetirementBySessionId) {
    if (
      !structuredAgentLaunchCancellationBelongsTo(sessionId, target) ||
      retirement.retireAfterInventory === null ||
      authoritativeInventory < retirement.retireAfterInventory
    ) {
      retainedSessionIds.add(sessionId)
    }
  }
  const changed =
    retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(retainedSessionIds)
  if (changed) {
    for (const sessionId of cancellationRetirementBySessionId.keys()) {
      if (!hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)) {
        cancellationRetirementBySessionId.delete(sessionId)
      }
    }
  }
  return changed
}
