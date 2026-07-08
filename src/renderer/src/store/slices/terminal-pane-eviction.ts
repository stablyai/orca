import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// STA-1282. The ONLY reactive state eviction needs in the store is the effective
// warm set the overlay gate reads. All other eviction bookkeeping (last-visible
// timestamps, the visible set, in-flight teardown generations, the dwell timer)
// lives in the coordinator module, which is event-driven and off the React
// render path so no store subscriber re-scans it on unrelated ticks.

export type TerminalPaneEvictionSlice = {
  /** tabId -> true for hidden panes the eviction coordinator keeps mounted
   *  (Tier 1 warm, or exempt: newborn/dead/wake-hint). The overlay gate renders
   *  a pane iff it is visible now OR this is true. Absent for evicted (Tier 2)
   *  and never-visited hidden tabs — that absence is the mount-storm fix. */
  terminalPaneMountByTabId: Record<string, boolean>
  /** Replace the effective warm set (coordinator-owned). */
  setTerminalPaneMountByTabId: (next: Record<string, boolean>) => void
}

export const createTerminalPaneEvictionSlice: StateCreator<
  AppState,
  [],
  [],
  TerminalPaneEvictionSlice
> = (set) => ({
  terminalPaneMountByTabId: {},
  setTerminalPaneMountByTabId: (next) => set({ terminalPaneMountByTabId: next })
})
