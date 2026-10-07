import { useSyncExternalStore } from 'react'

const pending = new Set<string>()
const uncertain = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function markWorktreeParentMutationUncertain(key: string): void {
  uncertain.add(key)
  notify()
}

export function clearWorktreeParentMutationUncertain(key: string): void {
  uncertain.delete(key)
  notify()
}

export function useWorktreeParentMutationPending(
  key: string | null,
  includeUncertain = false
): boolean {
  return useSyncExternalStore(
    subscribe,
    () => key !== null && (pending.has(key) || (includeUncertain && uncertain.has(key))),
    () => false
  )
}

export async function withWorktreeParentMutation<T>(
  key: string,
  mutate: () => Promise<T>
): Promise<T> {
  if (pending.has(key) || uncertain.has(key)) {
    throw new Error('A parent update is already in progress for this workspace.')
  }
  pending.add(key)
  notify()
  try {
    return await mutate()
  } finally {
    pending.delete(key)
    notify()
  }
}
