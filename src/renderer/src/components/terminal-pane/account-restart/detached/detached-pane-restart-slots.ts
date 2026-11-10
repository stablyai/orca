const slotHolderPtyIds = new Set<string>()
// Why: one stalled spawn must not block the batch, but a large batch must not fan out every agent launch at once.
const MAX_CONCURRENT_RESTARTS = 4
// Why: an unsettled spawn must not hold a slot or a silent input block forever; its claim stays until it settles.
export const STALLED_DETACHED_RESTART_MS = 90_000

export function hasFreeDetachedRestartSlot(): boolean {
  return slotHolderPtyIds.size < MAX_CONCURRENT_RESTARTS
}

/** Holds a slot for `ptyId` until released or, after the stall deadline, frees it and calls `onStall`. */
export function holdDetachedRestartSlot(ptyId: string, onStall: () => void): () => void {
  slotHolderPtyIds.add(ptyId)
  const timer = setTimeout(() => {
    if (slotHolderPtyIds.delete(ptyId)) {
      onStall()
    }
  }, STALLED_DETACHED_RESTART_MS)
  return () => {
    clearTimeout(timer)
    slotHolderPtyIds.delete(ptyId)
  }
}

export function resetDetachedRestartSlotsForTests(): void {
  slotHolderPtyIds.clear()
}
