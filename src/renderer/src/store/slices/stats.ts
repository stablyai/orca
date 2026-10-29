import type { SessionStateCreator } from '@/store/session-source-write-boundary'
import type { AppState } from '../types'
import type { StatsSummary } from '../../../../shared/process-stats-types'

export type StatsSlice = {
  statsSummary: StatsSummary | null
  fetchStatsSummary: () => Promise<void>
}

export const createStatsSlice: SessionStateCreator<AppState, StatsSlice> = (set) => ({
  statsSummary: null,

  fetchStatsSummary: async () => {
    try {
      const summary = await window.api.stats.getSummary()
      set({ statsSummary: summary })
    } catch (err) {
      console.error('Failed to fetch stats summary:', err)
    }
  }
})
