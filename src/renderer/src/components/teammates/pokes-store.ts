// Pokes opt-in state for the signed-in team (the control plane stores it per account), shared by
// the Experimental setting, teammate profiles and the in-app delivery poller.
import { useSyncExternalStore } from 'react'
import type { Poke } from '../../../../shared/cloud-workspaces/team-presence-wire'

export type PokesState = {
  /** Account the state belongs to; anything else is stale. */
  accountKey: string | null
  /** null until the first read answers. */
  enabled: boolean | null
  saving: boolean
  /** The last read or save that failed (cleared by the next one that works). */
  error: 'read' | 'save' | null
}

// Machine state codes (never shown); the setting maps each to its own copy.
const READ_FAILED = 'read' as const
const SAVE_FAILED = 'save' as const

let state: PokesState = { accountKey: null, enabled: null, saving: false, error: null }
const listeners = new Set<() => void>()

function set(next: Partial<PokesState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePokesState(): PokesState {
  return useSyncExternalStore(subscribe, () => state)
}

export function getPokesState(): PokesState {
  return state
}

/** Reads the opt-in (and anything waiting) for this account. Returns waiting pokes when enabled. */
export async function readPokes(accountKey: string): Promise<Poke[]> {
  if (state.accountKey !== accountKey) {
    set({ accountKey, enabled: null, error: null })
  }
  const result = await window.api.cloudWorkspaces.pokeInbox().catch(() => null)
  if (state.accountKey !== accountKey) {
    return []
  }
  if (!result?.ok) {
    // Keep the last known value; a blip shouldn't flip the switch.
    set({ error: READ_FAILED })
    return []
  }
  set({ enabled: result.value.enabled, error: null })
  return result.value.pokes
}

export async function setPokesEnabled(accountKey: string, enabled: boolean): Promise<boolean> {
  const previous = state.enabled
  set({ accountKey, enabled, saving: true, error: null })
  const result = await window.api.cloudWorkspaces.setPokesEnabled(enabled).catch(() => null)
  if (state.accountKey !== accountKey) {
    return false
  }
  if (result?.ok) {
    set({ enabled: result.value, saving: false })
    return true
  }
  set({ enabled: previous, saving: false, error: SAVE_FAILED })
  return false
}

/** Test-only reset. */
export function resetPokesStateForTests(): void {
  state = { accountKey: null, enabled: null, saving: false, error: null }
}
