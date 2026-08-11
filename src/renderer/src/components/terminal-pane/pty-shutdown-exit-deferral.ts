import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import {
  unregisterPtyDataHandlers,
  type PtyDataHandlerShutdownSnapshot
} from './pty-shutdown-data-suspension'
import { shouldApplyHostSleepPhase } from './pty-shutdown-host-generation'
import {
  consumeRendererCommittedPtyShutdownExit,
  settleDeferredPtyShutdownExits
} from './pty-shutdown-exit-callback-registry'
export {
  capturePtyShutdownExitScope,
  deferPtyShutdownExit,
  markCommittedPtyShutdowns,
  registerPtyShutdownExitIncarnation,
  releaseDeferredPtyShutdownExitsOutsideScope,
  settleDeferredPtyShutdownExits,
  settleScopedDeferredPtyShutdownExits,
  type PtyShutdownExitIncarnation,
  type PtyShutdownExitScope,
  type PtyShutdownSettlement
} from './pty-shutdown-exit-callback-registry'

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
const HOST_SLEEP_DISPOSITION_GRACE_MS = 30_000

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
  return consumeRendererCommittedPtyShutdownExit(ptyId)
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
