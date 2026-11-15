const revisions = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
const addressedListeners = new Set<(worktreeId: string) => void>()
let epoch = 0

export function terminalParkingInputEpoch(): number {
  return epoch
}

export function terminalParkingInputRevision(worktreeId: string): number {
  return revisions.get(worktreeId) ?? 0
}

export function invalidateTerminalParkingInputs(worktreeId: string): void {
  epoch += 1
  revisions.set(worktreeId, epoch)
  for (const listener of listeners.get(worktreeId) ?? []) {
    listener()
  }
  for (const listener of addressedListeners) {
    listener(worktreeId)
  }
}

export function retireTerminalParkingInputs(worktreeId: string): void {
  if (!revisions.delete(worktreeId)) {
    return
  }
  epoch += 1
  for (const listener of listeners.get(worktreeId) ?? []) {
    listener()
  }
  for (const listener of addressedListeners) {
    listener(worktreeId)
  }
}

export function subscribeTerminalParkingInputs(worktreeId: string, listener: () => void) {
  let bucket = listeners.get(worktreeId)
  if (!bucket) {
    listeners.set(worktreeId, (bucket = new Set()))
  }
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) {
      listeners.delete(worktreeId)
    }
  }
}

export function subscribeAddressedTerminalParkingInputs(
  listener: (worktreeId: string) => void
): () => void {
  addressedListeners.add(listener)
  return () => addressedListeners.delete(listener)
}
