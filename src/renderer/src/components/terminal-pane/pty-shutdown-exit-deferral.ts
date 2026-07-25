import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  unregisterPtyDataHandlers,
  type PtyDataHandlerShutdownSnapshot
} from './pty-shutdown-data-suspension'
import { shouldApplyHostSleepPhase } from './pty-shutdown-host-generation'

export type PtyShutdownSettlement = 'committed' | 'rolled-back'

const deferredExitCallbacksByPtyId = new Map<
  string,
  Set<(settlement: PtyShutdownSettlement) => void>
>()
const committedExitExpiresAtByPtyId = new Map<string, number>()
const committedPendingSettlements = new Set<string>()
const hostSleepDispositionByPtyId = new Map<
  string,
  {
    generation: number
    phase: 'pending' | 'committed'
    expiresAt: number
    snapshot?: PtyDataHandlerShutdownSnapshot
    expiryTimer?: ReturnType<typeof setTimeout>
    ptyId: string
  }
>()
// Why: RPC and transport streams can reorder a committed exit; 30 seconds covers delayed delivery while 512 bounds abandoned guards.
const COMMITTED_EXIT_GRACE_MS = 30_000
const COMMITTED_EXIT_MAX = 512
const HOST_SLEEP_DISPOSITION_GRACE_MS = 30_000

function pruneCommittedExitGuards(now = Date.now()): void {
  for (const [ptyId, expiresAt] of committedExitExpiresAtByPtyId) {
    if (expiresAt <= now) {
      committedExitExpiresAtByPtyId.delete(ptyId)
    }
  }
  while (committedExitExpiresAtByPtyId.size > COMMITTED_EXIT_MAX) {
    const oldestPtyId = committedExitExpiresAtByPtyId.keys().next().value
    if (typeof oldestPtyId !== 'string') {
      break
    }
    committedExitExpiresAtByPtyId.delete(oldestPtyId)
  }
}

function pruneHostSleepDispositions(now = Date.now()): void {
  for (const [key, disposition] of hostSleepDispositionByPtyId) {
    if (disposition.expiresAt <= now) {
      expireHostSleepDisposition(key, disposition)
    }
  }
}

function installHostSleepDisposition(
  key: string,
  disposition: Omit<NonNullable<ReturnType<typeof hostSleepDispositionByPtyId.get>>, 'expiryTimer'>
): void {
  const installed = { ...disposition } as NonNullable<
    ReturnType<typeof hostSleepDispositionByPtyId.get>
  >
  hostSleepDispositionByPtyId.set(key, installed)
  scheduleHostSleepDispositionExpiry(key, installed)
}

function scheduleHostSleepDispositionExpiry(
  key: string,
  disposition: NonNullable<ReturnType<typeof hostSleepDispositionByPtyId.get>>
): void {
  if (disposition.expiryTimer !== undefined) {
    clearTimeout(disposition.expiryTimer)
  }
  disposition.expiryTimer = setTimeout(
    () => {
      expireHostSleepDisposition(key, disposition)
    },
    Math.max(0, disposition.expiresAt - Date.now())
  )
}

function expireHostSleepDisposition(
  key: string,
  disposition: NonNullable<ReturnType<typeof hostSleepDispositionByPtyId.get>>
): void {
  if (hostSleepDispositionByPtyId.get(key) !== disposition) {
    return
  }
  if (disposition.expiryTimer !== undefined) {
    clearTimeout(disposition.expiryTimer)
  }
  disposition.snapshot?.rollback()
  hostSleepDispositionByPtyId.delete(key)
  if (disposition.phase === 'pending') {
    settleDeferredPtyShutdownExits([disposition.ptyId], 'rolled-back')
  }
}

export function markCommittedPtyShutdowns(ptyIds: readonly string[]): void {
  const expiresAt = Date.now() + COMMITTED_EXIT_GRACE_MS
  for (const ptyId of ptyIds) {
    committedExitExpiresAtByPtyId.delete(ptyId)
    committedExitExpiresAtByPtyId.set(ptyId, expiresAt)
  }
  pruneCommittedExitGuards()
}

export function noteCommittedPtyShutdownSettlements(ptyIds: readonly string[]): void {
  for (const ptyId of ptyIds) {
    committedPendingSettlements.add(ptyId)
  }
}

export function hasCommittedPtyShutdownSettlement(ptyId: string): boolean {
  return committedPendingSettlements.has(ptyId)
}

export function clearCommittedPtyShutdownSettlements(ptyIds: readonly string[]): void {
  for (const ptyId of ptyIds) {
    committedPendingSettlements.delete(ptyId)
  }
}

export function consumeCommittedPtyShutdownExit(
  ptyId: string,
  runtimeEnvironmentId?: string | null
): boolean {
  pruneCommittedExitGuards()
  pruneHostSleepDispositions()
  if (runtimeEnvironmentId) {
    const hostKey = hostSleepPtyKey(runtimeEnvironmentId, ptyId)
    if (hostSleepDispositionByPtyId.get(hostKey)?.phase === 'committed') {
      const disposition = hostSleepDispositionByPtyId.get(hostKey)
      if (disposition?.expiryTimer !== undefined) {
        clearTimeout(disposition.expiryTimer)
      }
      hostSleepDispositionByPtyId.delete(hostKey)
      return true
    }
  }
  if (!committedExitExpiresAtByPtyId.has(ptyId)) {
    return false
  }
  committedExitExpiresAtByPtyId.delete(ptyId)
  return true
}

export function isHostPtySleepPending(
  ptyId: string,
  runtimeEnvironmentId?: string | null
): boolean {
  pruneHostSleepDispositions()
  return Boolean(
    runtimeEnvironmentId &&
    hostSleepDispositionByPtyId.get(hostSleepPtyKey(runtimeEnvironmentId, ptyId))?.phase ===
      'pending'
  )
}

export function applyHostWorktreeTerminalSleepState(
  runtimeEnvironmentId: string,
  event: Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }>
): void {
  pruneHostSleepDispositions()
  const remotePtyIds = event.terminalHandles.map((handle) =>
    toRemoteRuntimePtyId(handle, runtimeEnvironmentId)
  )
  if (event.phase === 'started') {
    const newlyPendingPtyIds = remotePtyIds.filter((ptyId) => {
      const key = hostSleepPtyKey(runtimeEnvironmentId, ptyId)
      const existing = hostSleepDispositionByPtyId.get(key)
      if (!shouldApplyHostSleepPhase(key, event.generation, event.phase, existing)) {
        return false
      }
      if (existing?.generation === event.generation && existing.phase === 'pending') {
        existing.expiresAt = Date.now() + HOST_SLEEP_DISPOSITION_GRACE_MS
        scheduleHostSleepDispositionExpiry(key, existing)
        return false
      }
      existing?.snapshot?.rollback()
      if (existing?.expiryTimer !== undefined) {
        clearTimeout(existing.expiryTimer)
      }
      hostSleepDispositionByPtyId.delete(key)
      return true
    })
    const snapshots = unregisterPtyDataHandlers(newlyPendingPtyIds)
    for (const ptyId of newlyPendingPtyIds) {
      installHostSleepDisposition(hostSleepPtyKey(runtimeEnvironmentId, ptyId), {
        generation: event.generation,
        phase: 'pending',
        expiresAt: Date.now() + HOST_SLEEP_DISPOSITION_GRACE_MS,
        snapshot: snapshots.find((snapshot) => snapshot.ptyId === ptyId),
        ptyId
      })
    }
    return
  }
  if (event.phase === 'committed') {
    // Why: commit is self-contained so a client that subscribed after `started` still classifies the ordered terminal exit as reversible.
    const committedPtyIds: string[] = []
    for (const ptyId of remotePtyIds) {
      const key = hostSleepPtyKey(runtimeEnvironmentId, ptyId)
      const existing = hostSleepDispositionByPtyId.get(key)
      if (!shouldApplyHostSleepPhase(key, event.generation, event.phase, existing)) {
        continue
      }
      if (existing?.generation === event.generation) {
        existing.snapshot?.commit()
      } else {
        existing?.snapshot?.rollback()
      }
      if (existing?.expiryTimer !== undefined) {
        clearTimeout(existing.expiryTimer)
      }
      installHostSleepDisposition(hostSleepPtyKey(runtimeEnvironmentId, ptyId), {
        generation: event.generation,
        phase: 'committed',
        expiresAt: Date.now() + HOST_SLEEP_DISPOSITION_GRACE_MS,
        ptyId
      })
      committedPtyIds.push(ptyId)
    }
    settleDeferredPtyShutdownExits(committedPtyIds, 'committed')
    return
  }
  const committedOnWakePtyIds: string[] = []
  const rolledBackPtyIds: string[] = []
  for (const ptyId of remotePtyIds) {
    const key = hostSleepPtyKey(runtimeEnvironmentId, ptyId)
    const disposition = hostSleepDispositionByPtyId.get(key)
    if (!shouldApplyHostSleepPhase(key, event.generation, event.phase, disposition)) {
      continue
    }
    if (disposition?.generation !== event.generation) {
      continue
    }
    const commitMissedSleep = event.phase === 'woken' && disposition.phase === 'pending'
    if (commitMissedSleep) {
      disposition.snapshot?.commit()
    } else {
      disposition.snapshot?.rollback()
    }
    if (disposition?.expiryTimer !== undefined) {
      clearTimeout(disposition.expiryTimer)
    }
    hostSleepDispositionByPtyId.delete(key)
    if (commitMissedSleep) {
      committedOnWakePtyIds.push(ptyId)
    } else {
      rolledBackPtyIds.push(ptyId)
    }
  }
  settleDeferredPtyShutdownExits(committedOnWakePtyIds, 'committed')
  settleDeferredPtyShutdownExits(rolledBackPtyIds, 'rolled-back')
}

function hostSleepPtyKey(runtimeEnvironmentId: string, ptyId: string): string {
  return `${runtimeEnvironmentId}\0${ptyId}`
}

export function deferPtyShutdownExit(
  ptyId: string,
  callback: (settlement: PtyShutdownSettlement) => void
): void {
  const callbacks = deferredExitCallbacksByPtyId.get(ptyId) ?? new Set()
  callbacks.add(callback)
  deferredExitCallbacksByPtyId.set(ptyId, callbacks)
}

export function settleDeferredPtyShutdownExits(
  ptyIds: readonly string[],
  settlement: PtyShutdownSettlement
): void {
  for (const ptyId of ptyIds) {
    const callbacks = deferredExitCallbacksByPtyId.get(ptyId)
    if (!callbacks) {
      continue
    }
    deferredExitCallbacksByPtyId.delete(ptyId)
    if (settlement === 'committed') {
      // Why: replay classifies the old exit; retaining its guard could misclassify a same-ID session woken immediately afterward.
      committedExitExpiresAtByPtyId.delete(ptyId)
    }
    for (const callback of callbacks) {
      try {
        callback(settlement)
      } catch (error) {
        // Why: settlement is already fixed; one stale pane callback cannot block sibling cleanup or alter the reported outcome.
        console.error('[terminal] deferred PTY shutdown exit cleanup failed', {
          ptyId,
          settlement,
          error
        })
      }
    }
  }
}
