// Open state for the plans dialog. Every "Plan & billing", "Upgrade", "Choose plan" and "Compare
// plans" entry point calls openPlansDialog(); PlansDialogHost renders it.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  open = next
  for (const listener of listeners) {
    listener()
  }
}

export function openPlansDialog(): void {
  set(true)
}

export function closePlansDialog(): void {
  set(false)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePlansDialogOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open)
}
