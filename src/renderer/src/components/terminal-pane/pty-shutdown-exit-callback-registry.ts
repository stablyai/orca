export type PtyShutdownSettlement = 'committed' | 'rolled-back' | 'unrelated'

export type PtyShutdownExitIncarnation = symbol

type DeferredExitCallback = {
  callback: (settlement: PtyShutdownSettlement) => void
  incarnation?: PtyShutdownExitIncarnation
}

export type PtyShutdownExitScope = {
  incarnationsByPtyId: ReadonlyMap<string, ReadonlySet<PtyShutdownExitIncarnation>>
}

const deferredExitCallbacksByPtyId = new Map<string, Set<DeferredExitCallback>>()
const activeExitIncarnationsByPtyId = new Map<string, Set<PtyShutdownExitIncarnation>>()
const committedExitExpiresAtByPtyId = new Map<string, number>()
// Why: RPC and transport streams can reorder a committed exit; 30 seconds covers delayed delivery while 512 bounds abandoned guards.
const COMMITTED_EXIT_GRACE_MS = 30_000
const COMMITTED_EXIT_MAX = 512

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

export function markCommittedPtyShutdowns(ptyIds: readonly string[]): void {
  const expiresAt = Date.now() + COMMITTED_EXIT_GRACE_MS
  for (const ptyId of ptyIds) {
    committedExitExpiresAtByPtyId.delete(ptyId)
    committedExitExpiresAtByPtyId.set(ptyId, expiresAt)
  }
  pruneCommittedExitGuards()
}

export function consumeRendererCommittedPtyShutdownExit(ptyId: string): boolean {
  pruneCommittedExitGuards()
  if (!committedExitExpiresAtByPtyId.has(ptyId)) {
    return false
  }
  committedExitExpiresAtByPtyId.delete(ptyId)
  return true
}

export function registerPtyShutdownExitIncarnation(ptyId: string): {
  incarnation: PtyShutdownExitIncarnation
  unregister: () => void
} {
  const incarnation = Symbol(ptyId)
  const incarnations = activeExitIncarnationsByPtyId.get(ptyId) ?? new Set()
  incarnations.add(incarnation)
  activeExitIncarnationsByPtyId.set(ptyId, incarnations)
  return {
    incarnation,
    unregister: () => {
      incarnations.delete(incarnation)
      if (incarnations.size === 0) {
        activeExitIncarnationsByPtyId.delete(ptyId)
      }
    }
  }
}

export function capturePtyShutdownExitScope(ptyIds: readonly string[]): PtyShutdownExitScope {
  return {
    incarnationsByPtyId: new Map(
      ptyIds.map((ptyId) => [ptyId, new Set(activeExitIncarnationsByPtyId.get(ptyId) ?? [])])
    )
  }
}

export function deferPtyShutdownExit(
  ptyId: string,
  callback: (settlement: PtyShutdownSettlement) => void,
  incarnation?: PtyShutdownExitIncarnation
): void {
  const callbacks = deferredExitCallbacksByPtyId.get(ptyId) ?? new Set()
  callbacks.add({ callback, incarnation })
  deferredExitCallbacksByPtyId.set(ptyId, callbacks)
}

export function settleDeferredPtyShutdownExits(
  ptyIds: readonly string[],
  settlement: PtyShutdownSettlement
): void {
  for (const ptyId of ptyIds) {
    settleDeferredPtyShutdownExitCallbacks(ptyId, settlement, () => true)
  }
}

export function settleScopedDeferredPtyShutdownExits(
  ptyIds: readonly string[],
  settlement: PtyShutdownSettlement,
  scope: PtyShutdownExitScope
): void {
  for (const ptyId of ptyIds) {
    const scopedIncarnations = scope.incarnationsByPtyId.get(ptyId)
    settleDeferredPtyShutdownExitCallbacks(
      ptyId,
      settlement,
      ({ incarnation }) =>
        incarnation === undefined || scopedIncarnations?.has(incarnation) === true
    )
  }
}

export function releaseDeferredPtyShutdownExitsOutsideScope(
  ptyIds: readonly string[],
  scope: PtyShutdownExitScope
): void {
  for (const ptyId of ptyIds) {
    const scopedIncarnations = scope.incarnationsByPtyId.get(ptyId)
    settleDeferredPtyShutdownExitCallbacks(
      ptyId,
      'unrelated',
      ({ incarnation }) =>
        incarnation !== undefined && scopedIncarnations?.has(incarnation) !== true
    )
  }
}

function settleDeferredPtyShutdownExitCallbacks(
  ptyId: string,
  settlement: PtyShutdownSettlement,
  shouldSettle: (callback: DeferredExitCallback) => boolean
): void {
  const callbacks = deferredExitCallbacksByPtyId.get(ptyId)
  if (!callbacks) {
    return
  }
  const settling = [...callbacks].filter(shouldSettle)
  for (const callback of settling) {
    callbacks.delete(callback)
  }
  if (callbacks.size === 0) {
    deferredExitCallbacksByPtyId.delete(ptyId)
  }
  if (settlement === 'committed' && settling.length > 0) {
    committedExitExpiresAtByPtyId.delete(ptyId)
  }
  for (const { callback } of settling) {
    try {
      callback(settlement)
    } catch (error) {
      console.error('[terminal] deferred PTY shutdown exit cleanup failed', {
        ptyId,
        settlement,
        error
      })
    }
  }
}
