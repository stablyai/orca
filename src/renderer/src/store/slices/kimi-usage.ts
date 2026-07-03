import type { StateCreator } from 'zustand'
import type {
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageRange,
  KimiUsageScanState,
  KimiUsageScope,
  KimiUsageSessionRow,
  KimiUsageSnapshot,
  KimiUsageSummary
} from '../../../../shared/kimi-usage-types'
import type { AppState } from '../types'

export type KimiUsageSlice = {
  kimiUsageScope: KimiUsageScope
  kimiUsageRange: KimiUsageRange
  kimiUsageScanState: KimiUsageScanState | null
  kimiUsageSummary: KimiUsageSummary | null
  kimiUsageDaily: KimiUsageDailyPoint[]
  kimiUsageModelBreakdown: KimiUsageBreakdownRow[]
  kimiUsageProjectBreakdown: KimiUsageBreakdownRow[]
  kimiUsageRecentSessions: KimiUsageSessionRow[]
  setKimiUsageEnabled: (enabled: boolean) => Promise<void>
  setKimiUsageScope: (scope: KimiUsageScope) => Promise<void>
  setKimiUsageRange: (range: KimiUsageRange) => Promise<void>
  fetchKimiUsage: (opts?: { forceRefresh?: boolean }) => Promise<void>
  enableKimiUsage: () => Promise<void>
  refreshKimiUsage: () => Promise<void>
}

export const createKimiUsageSlice: StateCreator<AppState, [], [], KimiUsageSlice> = (set, get) => ({
  kimiUsageScope: 'orca',
  kimiUsageRange: '30d',
  kimiUsageScanState: null,
  kimiUsageSummary: null,
  kimiUsageDaily: [],
  kimiUsageModelBreakdown: [],
  kimiUsageProjectBreakdown: [],
  kimiUsageRecentSessions: [],

  setKimiUsageEnabled: async (enabled) => {
    try {
      const nextScanState = (await window.api.kimiUsage.setEnabled({
        enabled
      })) as KimiUsageScanState
      set({
        kimiUsageScanState: enabled
          ? {
              ...nextScanState,
              isScanning: true,
              lastScanCompletedAt: null,
              lastScanError: null
            }
          : nextScanState,
        kimiUsageSummary: null,
        kimiUsageDaily: [],
        kimiUsageModelBreakdown: [],
        kimiUsageProjectBreakdown: [],
        kimiUsageRecentSessions: []
      })
      if (enabled) {
        await get().fetchKimiUsage({ forceRefresh: true })
      }
    } catch (error) {
      console.error('Failed to update Kimi usage setting:', error)
    }
  },

  setKimiUsageScope: async (scope) => {
    set({ kimiUsageScope: scope })
    await get().fetchKimiUsage()
  },

  setKimiUsageRange: async (range) => {
    set({ kimiUsageRange: range })
    await get().fetchKimiUsage()
  },

  fetchKimiUsage: async (opts) => {
    try {
      const scanState = (await window.api.kimiUsage.getScanState()) as KimiUsageScanState
      const currentScanState = get().kimiUsageScanState
      const shouldPreserveLoadingState =
        opts?.forceRefresh === true &&
        currentScanState?.enabled === true &&
        get().kimiUsageSummary === null
      set({
        kimiUsageScanState: shouldPreserveLoadingState
          ? {
              ...scanState,
              isScanning: true,
              lastScanCompletedAt: null,
              lastScanError: null
            }
          : scanState
      })
      if (!scanState.enabled) {
        return
      }

      const { kimiUsageScope, kimiUsageRange } = get()
      const snapshot = (await window.api.kimiUsage.getSnapshot({
        scope: kimiUsageScope,
        range: kimiUsageRange,
        limit: 10
      })) as KimiUsageSnapshot
      const hasCachedSnapshot =
        snapshot.scanState.lastScanCompletedAt !== null || snapshot.scanState.hasAnyKimiData

      if (hasCachedSnapshot) {
        set({
          kimiUsageScanState:
            opts?.forceRefresh === true
              ? { ...snapshot.scanState, isScanning: true }
              : snapshot.scanState,
          kimiUsageSummary: snapshot.summary,
          kimiUsageDaily: snapshot.daily,
          kimiUsageModelBreakdown: snapshot.modelBreakdown,
          kimiUsageProjectBreakdown: snapshot.projectBreakdown,
          kimiUsageRecentSessions: snapshot.recentSessions
        })
      } else {
        set({
          kimiUsageScanState: {
            ...scanState,
            isScanning: true,
            lastScanError: null
          }
        })
      }

      await window.api.kimiUsage.refresh({
        force: opts?.forceRefresh ?? false
      })
      const { kimiUsageScope: refreshedScope, kimiUsageRange: refreshedRange } = get()
      const refreshedSnapshot = (await window.api.kimiUsage.getSnapshot({
        scope: refreshedScope,
        range: refreshedRange,
        limit: 10
      })) as KimiUsageSnapshot

      set({
        kimiUsageScanState: refreshedSnapshot.scanState,
        kimiUsageSummary: refreshedSnapshot.summary,
        kimiUsageDaily: refreshedSnapshot.daily,
        kimiUsageModelBreakdown: refreshedSnapshot.modelBreakdown,
        kimiUsageProjectBreakdown: refreshedSnapshot.projectBreakdown,
        kimiUsageRecentSessions: refreshedSnapshot.recentSessions
      })
    } catch (error) {
      console.error('Failed to fetch Kimi usage:', error)
    }
  },

  enableKimiUsage: async () => {
    await get().setKimiUsageEnabled(true)
  },

  refreshKimiUsage: async () => {
    await get().fetchKimiUsage({ forceRefresh: true })
  }
})
