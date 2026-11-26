// Dev builds only: every change of the open workspace, with who changed it, to find what sends a
// newly created bot's page back to the previous one.
import type { StoreApi } from 'zustand'

type ActiveWorkspaceState = { activeWorktreeId: string | null }

export function logActiveWorkspaceChanges(store: StoreApi<ActiveWorkspaceState>): void {
  store.subscribe((state, previous) => {
    if (state.activeWorktreeId === previous.activeWorktreeId) {
      return
    }
    const caller = (new Error('active workspace changed').stack ?? '')
      .split('\n')
      .slice(2, 12)
      .join('\n')
    console.warn(
      `[active-workspace] ${previous.activeWorktreeId ?? 'none'} -> ${state.activeWorktreeId ?? 'none'}\n${caller}`
    )
  })
}
