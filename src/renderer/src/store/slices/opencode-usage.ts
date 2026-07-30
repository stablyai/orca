import type { StateCreator } from 'zustand'
import type {
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageRange,
  OpenCodeUsageScanState,
  OpenCodeUsageScope,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSnapshot,
  OpenCodeUsageSummary
} from '../../../../shared/opencode-usage-types'
import type { AppState } from '../types'

export type OpenCodeUsageSlice = {
  openCodeUsageScope: OpenCodeUsageScope
  openCodeUsageRange: OpenCodeUsageRange
  openCodeUsageScanState: OpenCodeUsageScanState | null
  openCodeUsageSummary: OpenCodeUsageSummary | null
  openCodeUsageDaily: OpenCodeUsageDailyPoint[]
  openCodeUsageModelBreakdown: OpenCodeUsageBreakdownRow[]
  openCodeUsageProjectBreakdown: OpenCodeUsageBreakdownRow[]
  openCodeUsageRecentSessions: OpenCodeUsageSessionRow[]
  setOpenCodeUsageEnabled: (enabled: boolean) => Promise<void>
  setOpenCodeUsageScope: (scope: OpenCodeUsageScope) => Promise<void>
  setOpenCodeUsageRange: (range: OpenCodeUsageRange) => Promise<void>
  fetchOpenCodeUsage: (opts?: { forceRefresh?: boolean }) => Promise<void>
  enableOpenCodeUsage: () => Promise<void>
  refreshOpenCodeUsage: () => Promise<void>
}

export const createOpenCodeUsageSlice: StateCreator<AppState, [], [], OpenCodeUsageSlice> = (
  set,
  get
) => ({
  openCodeUsageScope: 'orca',
  openCodeUsageRange: '30d',
  openCodeUsageScanState: null,
  openCodeUsageSummary: null,
  openCodeUsageDaily: [],
  openCodeUsageModelBreakdown: [],
  openCodeUsageProjectBreakdown: [],
  openCodeUsageRecentSessions: [],

  setOpenCodeUsageEnabled: async (enabled) => {
    try {
      const nextScanState = (await window.api.openCodeUsage.setEnabled({
        enabled
      })) as OpenCodeUsageScanState | undefined
      // Why: the web client (paired runtime) does not bridge the desktop-only
      // usage IPC; its preload fallback resolves this call to `undefined`. Bail
      // so the toggle no-ops instead of seeding an empty scan state and then
      // crashing on the follow-up fetch.
      if (!nextScanState) {
        return
      }
      set({
        openCodeUsageScanState: enabled
          ? {
              ...nextScanState,
              isScanning: true,
              lastScanCompletedAt: null,
              lastScanError: null
            }
          : nextScanState,
        openCodeUsageSummary: null,
        openCodeUsageDaily: [],
        openCodeUsageModelBreakdown: [],
        openCodeUsageProjectBreakdown: [],
        openCodeUsageRecentSessions: []
      })
      if (enabled) {
        await get().fetchOpenCodeUsage({ forceRefresh: true })
      }
    } catch (error) {
      console.error('Failed to update OpenCode usage setting:', error)
    }
  },

  setOpenCodeUsageScope: async (scope) => {
    set({ openCodeUsageScope: scope })
    await get().fetchOpenCodeUsage()
  },

  setOpenCodeUsageRange: async (range) => {
    set({ openCodeUsageRange: range })
    await get().fetchOpenCodeUsage()
  },

  fetchOpenCodeUsage: async (opts) => {
    try {
      const scanState = (await window.api.openCodeUsage.getScanState()) as
        | OpenCodeUsageScanState
        | undefined
      // Why: in the web client the usage IPC is unavailable and the preload
      // fallback resolves to `undefined`; reading `scanState.enabled` below would
      // throw `Cannot read properties of undefined (reading 'enabled')`. Treat an
      // absent scan state as "usage unavailable" and stop.
      if (!scanState) {
        return
      }
      const currentScanState = get().openCodeUsageScanState
      const shouldPreserveLoadingState =
        opts?.forceRefresh === true &&
        currentScanState?.enabled === true &&
        get().openCodeUsageSummary === null
      set({
        openCodeUsageScanState: shouldPreserveLoadingState
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

      const { openCodeUsageScope, openCodeUsageRange } = get()
      const snapshot = (await window.api.openCodeUsage.getSnapshot({
        scope: openCodeUsageScope,
        range: openCodeUsageRange,
        limit: 10
      })) as OpenCodeUsageSnapshot
      const hasCachedSnapshot =
        snapshot.scanState.lastScanCompletedAt !== null || snapshot.scanState.hasAnyOpenCodeData

      if (hasCachedSnapshot) {
        set({
          openCodeUsageScanState:
            opts?.forceRefresh === true
              ? { ...snapshot.scanState, isScanning: true }
              : snapshot.scanState,
          openCodeUsageSummary: snapshot.summary,
          openCodeUsageDaily: snapshot.daily,
          openCodeUsageModelBreakdown: snapshot.modelBreakdown,
          openCodeUsageProjectBreakdown: snapshot.projectBreakdown,
          openCodeUsageRecentSessions: snapshot.recentSessions
        })
      } else {
        set({
          openCodeUsageScanState: {
            ...scanState,
            isScanning: true,
            lastScanError: null
          }
        })
      }

      await window.api.openCodeUsage.refresh({
        force: opts?.forceRefresh ?? false
      })
      const { openCodeUsageScope: refreshedScope, openCodeUsageRange: refreshedRange } = get()
      const refreshedSnapshot = (await window.api.openCodeUsage.getSnapshot({
        scope: refreshedScope,
        range: refreshedRange,
        limit: 10
      })) as OpenCodeUsageSnapshot

      set({
        openCodeUsageScanState: refreshedSnapshot.scanState,
        openCodeUsageSummary: refreshedSnapshot.summary,
        openCodeUsageDaily: refreshedSnapshot.daily,
        openCodeUsageModelBreakdown: refreshedSnapshot.modelBreakdown,
        openCodeUsageProjectBreakdown: refreshedSnapshot.projectBreakdown,
        openCodeUsageRecentSessions: refreshedSnapshot.recentSessions
      })
    } catch (error) {
      console.error('Failed to fetch OpenCode usage:', error)
    }
  },

  enableOpenCodeUsage: async () => {
    await get().setOpenCodeUsageEnabled(true)
  },

  refreshOpenCodeUsage: async () => {
    await get().fetchOpenCodeUsage({ forceRefresh: true })
  }
})
