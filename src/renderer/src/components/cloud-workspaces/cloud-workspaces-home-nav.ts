// "Show cloud workspaces" from limit errors: go to the team list (Home), filtered to your own,
// so you can put one to sleep or delete it and try again.
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { CloudWorkspacesFilters } from './CloudWorkspacesToolbar'

let pendingFilters: Partial<CloudWorkspacesFilters> | null = null
const listeners = new Set<() => void>()

/** Home reads (and clears) this when it mounts or is already showing. */
export function takePendingHomeFilters(): Partial<CloudWorkspacesFilters> | null {
  const next = pendingFilters
  pendingFilters = null
  return next
}

export function onPendingHomeFilters(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openCloudWorkspacesHome(filters: Partial<CloudWorkspacesFilters> = {}): void {
  pendingFilters = { scope: 'mine', archived: false, ...filters }
  const state = useAppStore.getState()
  state.setActiveView('terminal')
  state.setActiveWorktree(null)
  listeners.forEach((listener) => listener())
}

/** Applies pending filters on mount and whenever another surface asks for Home again. */
export function usePendingHomeFilters(
  setFilters: React.Dispatch<React.SetStateAction<CloudWorkspacesFilters>>
): void {
  useEffect(() => {
    const take = (): void => {
      const pending = takePendingHomeFilters()
      if (pending) {
        setFilters((current) => ({ ...current, ...pending }))
      }
    }
    take()
    return onPendingHomeFilters(take)
  }, [setFilters])
}
