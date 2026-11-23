import { afterEach, expect, it, vi } from 'vitest'

const work = vi.hoisted(() => {
  const counters: { scanned: number; observed: number; rechecks: number; state: unknown } = {
    scanned: 0,
    observed: 0,
    rechecks: 0,
    state: {}
  }
  return counters
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => work.state } }))
vi.mock('@/store/terminals/agent-pane-sleep-in-flight', () => ({
  trackAgentPaneSleep: (_paneKey: string, sleep: () => Promise<void>) => sleep()
}))
vi.mock('./agent-hibernation-host-evidence', () => ({
  collectHostPtyEvidence: async () => ({
    runtimeLivePtyIdsByWorktreeId: {},
    runtimeLivenessRequiredWorktreeIds: [],
    attentionByWorktreeId: {}
  }),
  getRuntimeLivenessTargetWorktrees: () => new Map(),
  resolveAgentHibernationRuntimeOwner: () => ({ kind: 'non-runtime' })
}))
vi.mock('./agent-hibernation-pane-age', () => ({
  observeHibernationPtyBindings: () => {
    work.observed += 1
  },
  getHibernationPtyBindingFirstSeenAtByPaneKey: () => ({}),
  getHibernationBoundaryResolvedAtByPaneKey: () => ({})
}))
vi.mock('../../pane-manager/mobile-driver-state', () => ({ getAllDrivers: () => new Map() }))
vi.mock('../../../components/terminal-pane/parking/retention/foreground-terminal-tabs', () => ({
  getForegroundTerminalTabIds: () => [],
  getForegroundTerminalTabLastSeenAtById: () => ({})
}))
vi.mock('./agent-hibernation-output-activity', () => ({
  getAgentHibernationOutputSignature: () => 'quiet'
}))
vi.mock('../../terminal/input/terminal-input-activity-coalescing', () => ({
  mergePendingTerminalInputActivity: (stamps: unknown) => stamps
}))
vi.mock('../../window-activity/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
// Stands in for the planner, counting the panes and statuses each plan reads.
vi.mock('./agent-hibernation-planner', () => ({
  getEffectiveAgentHibernationIdleMs: () => 1,
  planAgentHibernationCandidates: (snapshot: {
    tabsByWorktree: Record<string, { id: string }[]>
    agentStatusByPaneKey: ReadonlyMap<string, { paneKey: string; tabId: string } | undefined>
  }) => {
    const candidates: unknown[] = []
    for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
      const tabIds = new Set(tabs.map((tab) => tab.id))
      work.scanned += tabs.length
      for (const entry of snapshot.agentStatusByPaneKey.values()) {
        work.scanned += 1
        if (entry && tabIds.has(entry.tabId)) {
          candidates.push({
            id: `${worktreeId}|${entry.paneKey}`,
            worktreeId,
            paneKey: entry.paneKey,
            tabId: entry.tabId,
            leafId: 'leaf',
            paneKeys: [entry.paneKey],
            targetPtyIds: [`pty-${entry.tabId}`],
            expectedRuntimePtyIds: [],
            signature: 'idle'
          })
        }
      }
    }
    return candidates
  }
}))

import {
  runAgentHibernationTick,
  stopAgentHibernationCoordinator
} from './agent-hibernation-coordinator'

afterEach(() => {
  stopAgentHibernationCoordinator()
  vi.restoreAllMocks()
})

it.each([100, 1_000])(
  'each pane about to sleep re-checks only itself (%i idle panes in one workspace)',
  async (count) => {
    const tabs = Array.from({ length: count }, (_, index) => ({ id: `tab-${index}` }))
    const statuses = new Map(
      tabs.map((tab) => [`${tab.id}:leaf`, { paneKey: `${tab.id}:leaf`, tabId: tab.id }])
    )
    let slept = 0
    work.state = {
      settings: {},
      tabsByWorktree: { wt: tabs },
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      agentStatusByPaneKey: statuses,
      sleepingAgentSessionsByPaneKey: {},
      lastTerminalInputAtByPaneKey: {},
      shutdownCompletedAgentPaneForHibernation: async (
        _worktreeId: string,
        options: { stillEligible: () => Promise<boolean> }
      ) => {
        work.rechecks += 1
        if (await options.stillEligible()) {
          slept += 1
        }
      }
    }
    await runAgentHibernationTick()
    work.scanned = 0
    work.observed = 0
    await runAgentHibernationTick()

    expect(slept).toBe(count)
    expect(work.observed).toBe(1)
    // The tick's own plan reads the fleet once; each pane's two re-checks read one tab and one status.
    expect(work.scanned).toBe(2 * count + count * 2 * 2)
  }
)
