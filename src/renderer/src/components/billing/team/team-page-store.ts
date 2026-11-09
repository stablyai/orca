// Open state for the Team page. Entry points: the account menu, Settings → Orca account, and
// a finished Checkout (which lands here with a one-time "You're on Team" confirmation).
import { useSyncExternalStore } from 'react'

export type TeamPageArrival = { kind: 'checkout-success'; seats: number } | null

type TeamPageState = { open: boolean; arrival: TeamPageArrival }

let state: TeamPageState = { open: false, arrival: null }
const listeners = new Set<() => void>()

function set(next: TeamPageState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

export function openTeamPage(arrival: TeamPageArrival = null): void {
  set({ open: true, arrival })
}

export function closeTeamPage(): void {
  set({ open: false, arrival: null })
}

/** The confirmation shows once; dismissing it (or closing the page) clears it. */
export function clearTeamPageArrival(): void {
  if (state.arrival) {
    set({ ...state, arrival: null })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getState(): TeamPageState {
  return state
}

export function useTeamPageState(): TeamPageState {
  return useSyncExternalStore(subscribe, getState)
}
