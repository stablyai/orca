import {
  getPaneSpawnDeferral,
  clearPaneSpawnDeferral
} from '../../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { cancelDeferredRestoreRetry } from '../../session-restore/spawn-deferral/pane-spawn-deferral-drain'
import type { PaneAccountRestart } from '@/store/terminals/terminal-contracts'

const slots = new Map<string, () => void>()
const MAX_CONCURRENT_RESTARTS = 4
export const STALLED_DETACHED_RESTART_MS = 90_000

export function hasFreeDetachedRestartSlot(): boolean {
  return slots.size < MAX_CONCURRENT_RESTARTS
}

export function holdDetachedRestartSlot(key: string, onStall: () => void): () => void {
  slots.get(key)?.()
  const release = (): void => {
    clearTimeout(timer)
    if (slots.get(key) === release) {
      slots.delete(key)
    }
  }
  const timer = setTimeout(() => {
    if (slots.get(key) !== release) {
      return
    }
    release()
    onStall()
  }, STALLED_DETACHED_RESTART_MS)
  slots.set(key, release)
  return release
}

export function accountRestartSlotKey(
  key: string,
  request: { requestId: string; attemptId: string; executorId?: string }
): string {
  return `${key}\0${request.requestId}\0${request.attemptId}\0${request.executorId ?? ''}`
}

/** Release resources at the same commit that retires delivery ownership. */
export function releaseRetiredAccountRestartSlots(
  before: Record<string, PaneAccountRestart>,
  after: Record<string, PaneAccountRestart>
): void {
  if (before === after) {
    return
  }
  for (const [key, request] of Object.entries(before)) {
    if (typeof request !== 'object') {
      continue
    }
    const next = after[key]
    if (
      typeof next === 'object' &&
      next.requestId === request.requestId &&
      next.attemptId === request.attemptId &&
      next.executorId === request.executorId
    ) {
      continue
    }
    slots.get(accountRestartSlotKey(key, request))?.()
    const deferred = getPaneSpawnDeferral(key)?.accountRestart
    if (deferred?.requestId === request.requestId && deferred.attemptId === request.attemptId) {
      cancelDeferredRestoreRetry(key)
      clearPaneSpawnDeferral(key)
    }
  }
}

export function resetDetachedRestartSlotsForTests(): void {
  for (const release of slots.values()) {
    release()
  }
}
