import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { StatsSummary } from '../../../../../shared/diagnostics/process-stats-types'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { USAGE_ANALYTICS_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/host-runtime-capabilities'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../../runtime/rpc/compatibility/runtime-capability-proof'
import { usageHostKey } from '../usage/usage-host'
import { clearUsageProviderData } from '../usage/usage-provider-slices'

/** Whether the shown host computes usage: `unknown` when it could not be asked, so its reads report the failure. */
export type StatsHostUsageSupport = 'checking' | 'supported' | 'unsupported' | 'unknown'

export type StatsSlice = {
  statsSummary: StatsSummary | null
  /** The host Stats & Usage reads, picked with the Settings Host picker. */
  statsHost: RuntimeClientTarget
  /** Bumped on every new view (host switch, shown again, regained contact); work started under an older value stops and is dropped. */
  statsHostEpoch: number
  statsHostUsageSupport: StatsHostUsageSupport
  setStatsHost: (host: RuntimeClientTarget) => void
  /** Shown again, or contact came back: read the host again, keeping its numbers meanwhile. */
  renewStatsHostView: () => void
  fetchStatsSummary: () => Promise<void>
}

export const createStatsSlice: StateCreator<AppState, [], [], StatsSlice> = (set, get) => {
  const startView = (host: RuntimeClientTarget, patch: Partial<AppState>): void => {
    const epoch = get().statsHostEpoch + 1
    set({
      ...patch,
      statsHost: host,
      statsHostEpoch: epoch,
      // A renewed view keeps a real answer so the panes stay up while the host is asked again.
      ...(host.kind === 'local'
        ? { statsHostUsageSupport: 'supported' }
        : get().statsHostUsageSupport === 'unknown'
          ? { statsHostUsageSupport: 'checking' }
          : {})
    })
    if (host.kind === 'local') {
      return
    }
    void runtimeEnvironmentSupportsCapability(
      host.environmentId,
      USAGE_ANALYTICS_RUNTIME_CAPABILITY
    )
      .then(
        (supported): StatsHostUsageSupport => (supported ? 'supported' : 'unsupported'),
        (): StatsHostUsageSupport => 'unknown'
      )
      .then((support) => {
        if (get().statsHostEpoch === epoch) {
          set({ statsHostUsageSupport: support })
        }
      })
  }
  return {
    statsSummary: null,
    statsHost: { kind: 'local' },
    statsHostEpoch: 0,
    statsHostUsageSupport: 'supported',

    setStatsHost: (host) => {
      if (usageHostKey(get().statsHost) === usageHostKey(host)) {
        return
      }
      startView(host, {
        statsSummary: null,
        statsHostUsageSupport: 'checking',
        ...clearUsageProviderData()
      })
    },

    renewStatsHostView: () => startView(get().statsHost, {}),

    fetchStatsSummary: async () => {
      const host = get().statsHost
      const epoch = get().statsHostEpoch
      try {
        const summary =
          host.kind === 'local'
            ? await window.api.stats.getSummary()
            : await callRuntimeRpc<StatsSummary>(host, 'stats.summary')
        // An answer from an earlier view, even of the same host, is stale.
        if (get().statsHostEpoch === epoch) {
          // A host without a stats collector answers `{}`.
          set({ statsSummary: typeof summary?.totalAgentsSpawned === 'number' ? summary : null })
        }
      } catch (err) {
        if (get().statsHostEpoch === epoch) {
          console.error('Failed to fetch stats summary:', err)
        }
      }
    }
  }
}
