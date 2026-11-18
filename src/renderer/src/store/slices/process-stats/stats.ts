import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { StatsSummary } from '../../../../../shared/diagnostics/process-stats-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { usageHostKey } from '../usage/usage-host'
import { clearUsageProviderData } from '../usage/usage-provider-slices'

export type StatsSlice = {
  statsSummary: StatsSummary | null
  /** The host Stats & Usage reads, picked with the Settings Host picker. */
  statsHost: RuntimeClientTarget
  /** Bumped on every host switch; usage work started under an older value is dropped. */
  statsHostEpoch: number
  setStatsHost: (host: RuntimeClientTarget) => void
  fetchStatsSummary: () => Promise<void>
}

export const createStatsSlice: StateCreator<AppState, [], [], StatsSlice> = (set, get) => ({
  statsSummary: null,
  statsHost: { kind: 'local' },
  statsHostEpoch: 0,

  setStatsHost: (host) => {
    if (usageHostKey(get().statsHost) === usageHostKey(host)) {
      return
    }
    set({
      statsHost: host,
      statsHostEpoch: get().statsHostEpoch + 1,
      statsSummary: null,
      ...clearUsageProviderData()
    })
  },

  fetchStatsSummary: async () => {
    const host = get().statsHost
    const view = get().statsHostEpoch
    try {
      const summary =
        host.kind === 'local'
          ? await window.api.stats.getSummary()
          : await callRuntimeRpc<StatsSummary>(host, 'stats.summary')
      // An answer from an earlier view, even of the same host, is stale.
      if (get().statsHostEpoch === view) {
        // A host without a stats collector answers `{}`.
        set({ statsSummary: typeof summary?.totalAgentsSpawned === 'number' ? summary : null })
      }
    } catch (err) {
      console.error('Failed to fetch stats summary:', err)
    }
  }
})
