import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'
import { floatingWorkspaceId } from '../../../shared/floating-workspace-id'

const STORAGE_KEY = 'orca:floating-workspace-host'
function readHost(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null
  } catch {
    return null
  }
}

const floatingWorkspaceHost = createStore<{
  environmentId: string | null
  selectHost: (environmentId: string | null) => void
}>((set) => ({
  environmentId: readHost(),
  selectHost: (environmentId) => {
    try {
      if (environmentId) {
        localStorage.setItem(STORAGE_KEY, environmentId)
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      /* Storage can be unavailable in private profiles. */
    }
    set({ environmentId })
  }
}))

export const useFloatingWorkspaceHost = Object.assign(
  <T>(selector: (state: ReturnType<typeof floatingWorkspaceHost.getState>) => T): T =>
    useSyncExternalStore(floatingWorkspaceHost.subscribe, () =>
      selector(floatingWorkspaceHost.getState())
    ),
  floatingWorkspaceHost
)

export function useFloatingWorkspaceId(): string {
  return useFloatingWorkspaceHost((state) => floatingWorkspaceId(state.environmentId))
}

export function getSelectedFloatingWorkspaceId(): string {
  return floatingWorkspaceId(useFloatingWorkspaceHost.getState().environmentId)
}
