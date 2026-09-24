import type { Page } from '@stablyai/playwright-test'
import {
  normalizeAccumulatedWorkspaceFixtureOptions,
  type AccumulatedWorkspaceFixtureOptions
} from './accumulated-workspace-profile'
import { buildAccumulatedWorkspaceSeed } from './accumulated-workspace-state-builder'

export type { AccumulatedWorkspaceFixtureOptions }

export type AccumulatedWorkspaceFixtureSummary = {
  repositories: number
  worktrees: number
  terminalTabs: number
  unifiedTabs: number
  terminalLayouts: number
  splitPanes: number
  parkedRecords: number
  lineageRecords: number
  liveStatuses: number
  serializedBytes: Record<string, number>
}

type FixtureWindow = Window & {
  __accumulatedFixtureCleanup?: () => void
  __orcaBenchmarkInstrumentation?: {
    reset: () => void
    start: () => void
    stop: () => void
    snapshot: () => unknown
  }
}

/** Seeds a production-scale accumulated profile without mounting synthetic PTYs. */
export async function seedAccumulatedWorkspaceFixture(
  page: Page,
  options: AccumulatedWorkspaceFixtureOptions = {}
): Promise<AccumulatedWorkspaceFixtureSummary> {
  const config = normalizeAccumulatedWorkspaceFixtureOptions(options)
  const seed = buildAccumulatedWorkspaceSeed(config)
  return page.evaluate(
    ({ config, seed }) => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      const target: FixtureWindow = window
      const before = store.getState()
      const settings = before.settings
      if (!settings) {
        throw new Error('settings unavailable')
      }
      const worktreesByRepo = { ...before.worktreesByRepo, ...seed.worktreesByRepo }
      store.setState((current) => ({
        repos: [...current.repos, ...seed.repos],
        worktreesByRepo,
        tabsByWorktree: { ...current.tabsByWorktree, ...seed.tabsByWorktree },
        ptyIdsByTabId: { ...current.ptyIdsByTabId, ...seed.ptyIdsByTabId },
        terminalLayoutsByTabId: {
          ...current.terminalLayoutsByTabId,
          ...seed.terminalLayoutsByTabId
        },
        unifiedTabsByWorktree: {
          ...current.unifiedTabsByWorktree,
          ...seed.unifiedTabsByWorktree
        },
        groupsByWorktree: { ...current.groupsByWorktree, ...seed.groupsByWorktree },
        activeGroupIdByWorktree: {
          ...current.activeGroupIdByWorktree,
          ...seed.activeGroupIdByWorktree
        },
        layoutByWorktree: { ...current.layoutByWorktree, ...seed.layoutByWorktree },
        sleepingAgentSessionsByPaneKey: {
          ...current.sleepingAgentSessionsByPaneKey,
          ...seed.sleepingAgentSessionsByPaneKey
        },
        worktreeLineageById: {
          ...current.worktreeLineageById,
          ...seed.worktreeLineageById
        },
        settings: {
          ...settings,
          tabAutoGenerateTitle: false,
          compactWorktreeCards: false,
          terminalScrollbackRows: 50_000
        }
      }))
      const now = Date.now()
      for (const status of seed.liveStatuses) {
        for (let historyIndex = 0; historyIndex < config.statusHistoryEntries; historyIndex += 1) {
          const historyRemaining = config.statusHistoryEntries - historyIndex
          store.getState().setAgentStatus(
            status.paneKey,
            {
              state: historyRemaining % 2 ? 'working' : 'waiting',
              prompt: status.prompt,
              agentType: 'codex'
            },
            'codex',
            {
              updatedAt: now - historyRemaining * 1_000,
              stateStartedAt: now - historyRemaining * 1_000
            },
            { tabId: status.tabId, worktreeId: status.worktreeId }
          )
        }
      }
      const syntheticStatuses = Object.fromEntries(
        Object.entries(store.getState().agentStatusByPaneKey).filter(([paneKey]) =>
          paneKey.startsWith('synthetic-tab-')
        )
      )
      const serializedSlices = {
        repos: seed.repos,
        worktreesByRepo: seed.worktreesByRepo,
        tabsByWorktree: seed.tabsByWorktree,
        unifiedTabsByWorktree: seed.unifiedTabsByWorktree,
        terminalLayoutsByTabId: seed.terminalLayoutsByTabId,
        sleepingAgentSessionsByPaneKey: seed.sleepingAgentSessionsByPaneKey,
        agentStatusByPaneKey: syntheticStatuses
      }
      const byteLength = (value: unknown): number =>
        new TextEncoder().encode(JSON.stringify(value)).byteLength
      const serializedBytes = Object.fromEntries(
        Object.entries(serializedSlices).map(([key, value]) => [key, byteLength(value)])
      )
      serializedBytes.total = byteLength(serializedSlices)
      target.__accumulatedFixtureCleanup = () => {
        store.setState({
          repos: before.repos,
          worktreesByRepo: before.worktreesByRepo,
          tabsByWorktree: before.tabsByWorktree,
          ptyIdsByTabId: before.ptyIdsByTabId,
          terminalLayoutsByTabId: before.terminalLayoutsByTabId,
          unifiedTabsByWorktree: before.unifiedTabsByWorktree,
          groupsByWorktree: before.groupsByWorktree,
          activeGroupIdByWorktree: before.activeGroupIdByWorktree,
          layoutByWorktree: before.layoutByWorktree,
          sleepingAgentSessionsByPaneKey: before.sleepingAgentSessionsByPaneKey,
          worktreeLineageById: before.worktreeLineageById,
          agentStatusByPaneKey: before.agentStatusByPaneKey,
          runtimePaneTitlesByTabId: before.runtimePaneTitlesByTabId,
          settings: before.settings
        })
        delete target.__accumulatedFixtureCleanup
      }
      const countLeaves = (node: (typeof seed.terminalLayoutsByTabId)[string]['root']): number => {
        if (!node) {
          return 0
        }
        return node.type === 'leaf' ? 1 : countLeaves(node.first) + countLeaves(node.second)
      }
      return {
        repositories: seed.repos.length,
        worktrees: Object.values(seed.worktreesByRepo).flat().length,
        terminalTabs: Object.values(seed.tabsByWorktree).flat().length,
        unifiedTabs: Object.values(seed.unifiedTabsByWorktree).flat().length,
        terminalLayouts: Object.keys(seed.terminalLayoutsByTabId).length,
        splitPanes: Object.values(seed.terminalLayoutsByTabId).reduce(
          (count, layout) => count + countLeaves(layout.root),
          0
        ),
        parkedRecords: Object.keys(seed.sleepingAgentSessionsByPaneKey).length,
        lineageRecords: Object.keys(seed.worktreeLineageById).length,
        liveStatuses: seed.liveStatuses.length,
        serializedBytes
      }
    },
    { config, seed }
  )
}

export async function startAccumulatedBenchmarkInstrumentation(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const target: FixtureWindow = window
    const instrumentation = target.__orcaBenchmarkInstrumentation
    if (!instrumentation) {
      return false
    }
    instrumentation.reset()
    instrumentation.start()
    return true
  })
}

export async function stopAccumulatedBenchmarkInstrumentation(
  page: Page
): Promise<
  | { available: true; snapshot: unknown }
  | { available: false; reason: 'not-installed'; snapshot: null }
> {
  return page.evaluate(() => {
    const target: FixtureWindow = window
    const instrumentation = target.__orcaBenchmarkInstrumentation
    if (!instrumentation) {
      return { available: false as const, reason: 'not-installed' as const, snapshot: null }
    }
    const snapshot = instrumentation.snapshot()
    instrumentation.stop()
    return { available: true as const, snapshot }
  })
}

export async function cleanupAccumulatedWorkspaceFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target: FixtureWindow = window
    target.__accumulatedFixtureCleanup?.()
  })
}
