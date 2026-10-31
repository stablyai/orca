import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { StatsSummary } from '../../../../shared/process-stats-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { runtimeTargetEnvironmentId } from '../../runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { createUsageProviderResetPatch } from './usage-provider-state'

export type StatsSlice = {
  statsSummary: StatsSummary | null
  /** Host whose Stats & Usage the Settings pane shows; every stats and usage read goes to it. */
  statsHost: RuntimeClientTarget
  setStatsHost: (host: RuntimeClientTarget) => void
  fetchStatsSummary: () => Promise<void>
}

export function isSameStatsHost(a: RuntimeClientTarget, b: RuntimeClientTarget): boolean {
  return runtimeTargetEnvironmentId(a) === runtimeTargetEnvironmentId(b)
}

function isStatsSummary(summary: Partial<StatsSummary>): summary is StatsSummary {
  return typeof summary.totalAgentsSpawned === 'number'
}

export const createStatsSlice: StateCreator<AppState, [], [], StatsSlice> = (set, get) => ({
  statsSummary: null,
  statsHost: { kind: 'local' },

  setStatsHost: (host) => {
    if (isSameStatsHost(get().statsHost, host)) {
      return
    }
    // Why: one host's numbers must never stay on screen under another host's name.
    set({ statsHost: host, statsSummary: null, ...createUsageProviderResetPatch() })
  },

  fetchStatsSummary: async () => {
    const host = get().statsHost
    try {
      const summary =
        host.kind === 'environment'
          ? await callRuntimeRpc<Partial<StatsSummary>>(host, 'stats.summary')
          : await window.api.stats.getSummary()
      if (isSameStatsHost(get().statsHost, host)) {
        // Why: a server without a stats collector answers `{}`.
        set({ statsSummary: isStatsSummary(summary) ? summary : null })
      }
    } catch (err) {
      console.error('Failed to fetch stats summary:', err)
    }
  }
})
