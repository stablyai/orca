// Open state for the plans page. Any entry point (account menu, Settings, a "start a cloud
// sandbox" upsell) calls openPlansPage(); PlansDialogHost renders it.
import { useSyncExternalStore } from 'react'

export type PlansPageSource = 'account-menu' | 'settings' | 'sandbox' | 'other'

type PlansPageState = { open: boolean; source: PlansPageSource | null }

let state: PlansPageState = { open: false, source: null }
const listeners = new Set<() => void>()

function set(next: PlansPageState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

export function openPlansPage(source: PlansPageSource = 'other'): void {
  set({ open: true, source })
}

export function closePlansPage(): void {
  set({ open: false, source: state.source })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPlansPageState(): PlansPageState {
  return state
}

export function usePlansPageState(): PlansPageState {
  return useSyncExternalStore(subscribe, getPlansPageState)
}
