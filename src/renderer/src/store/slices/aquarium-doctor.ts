import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AquariumDoctorResult } from '../../lib/aquarium-doctor'
import { computeDoctorScan } from '../../lib/aquarium-doctor'

// `Run doctor` slice: an on-demand verdict that reuses the panel's live
// sources. The daemon family is the only main-process-backed source, so the
// action refreshes it first (T9 daemonInventory:scan) then recomputes the
// whole verdict from the current store state — "Run doctor" always reflects
// fresh daemon liveness, while terminals/worktrees read the same inventory
// the panel renders (T8 close-out live data). A failed daemon refresh is
// recorded by the daemon-inventory slice and surfaces as a cliError in the
// verdict (Offer 4 — a partial scan is never reported healthy).

export type AquariumDoctorSlice = {
  doctorScan: AquariumDoctorResult | null
  doctorScanning: boolean
  runDoctorScan: () => Promise<AquariumDoctorResult>
}

export const createAquariumDoctorSlice: StateCreator<
  AppState,
  [],
  [],
  AquariumDoctorSlice
> = (set, get) => ({
  doctorScan: null,
  doctorScanning: false,

  runDoctorScan: async () => {
    set({ doctorScanning: true })
    try {
      // Refresh the daemon family first — it is the live signal the doctor
      // re-scans on demand (terminals/worktrees read the current inventory).
      // A failure is swallowed here: the daemon-inventory slice records it
      // into daemonInventoryError, and computeDoctorScan folds it into
      // cliErrors so the verdict is honestly partial, never falsely healthy.
      try {
        await get().scanDaemonInventory()
      } catch {
        // error already recorded in daemonInventoryError
      }
      const result = computeDoctorScan(get(), Date.now())
      set({ doctorScan: result, doctorScanning: false })
      return result
    } catch (error) {
      set({ doctorScanning: false })
      throw error
    }
  }
})
