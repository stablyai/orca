import type { AppState } from '@/store/types'

type StoreListener = (state: Partial<AppState>, previous: Partial<AppState>) => void
const listeners = new Set<StoreListener>()
let previous: Partial<AppState> = {}

export function subscribe(listener: StoreListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publish(state: Partial<AppState>): void {
  const snapshot = { ...state }
  listeners.forEach((listener) => listener(snapshot, previous))
  previous = snapshot
}

export function reset(): void {
  listeners.clear()
  previous = {}
}
