import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { DaemonInventoryScanResult } from '../../../../shared/daemon-inventory'

// T9 (stablyai-orca-gdd): renderer-side daemon inventory slice. Holds the
// main-process scan result (pid-file inventory + liveness) so the Aquarium
// panel can render daemon rows. Evidence-only semantics (T3/T8): entries are
// snapshot-input-shaped, never a standalone reap trigger; the renderer maps
// them to evidence-only entries in lib/aquarium-live.ts.

export type DaemonInventorySlice = {
  daemonInventoryScan: DaemonInventoryScanResult | null
  daemonInventoryLoading: boolean
  daemonInventoryError: string | null
  scanDaemonInventory: () => Promise<DaemonInventoryScanResult>
}

export const createDaemonInventorySlice: StateCreator<
  AppState,
  [],
  [],
  DaemonInventorySlice
> = (set) => ({
  daemonInventoryScan: null,
  daemonInventoryLoading: false,
  daemonInventoryError: null,

  scanDaemonInventory: async () => {
    set({ daemonInventoryLoading: true, daemonInventoryError: null })
    try {
      const result = await window.api.daemonInventory.scan()
      set({ daemonInventoryScan: result, daemonInventoryLoading: false })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ daemonInventoryError: message, daemonInventoryLoading: false })
      throw error
    }
  }
})
