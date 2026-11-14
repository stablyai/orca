// @vitest-environment happy-dom
import type * as ParkedWatcherRegistryModule from '../output-watchers/terminal-parked-watcher-registry'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

const mocks = vi.hoisted(() => ({
  storeState: {
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, { ptyIdsByLeafId?: Record<string, string> }>,
    // An empty catalog makes the unexercised capture repo gate preserve scrollback.
    repos: [],
    sleepingAgentSessionsByPaneKey: {} as Record<
      string,
      { paneKey: string; tabId?: string; worktreeId: string }
    >
  },
  exemptTabIds: new Set<string>(),
  /** Toggled to churn the park verdict the way the crash cluster does. */
  watcherCoverage: true
}))

vi.mock('../../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mocks.storeState),
    { getState: () => mocks.storeState }
  )
}))

vi.mock('../retention/terminal-eviction-exempt-tabs', () => ({
  selectEvictionExemptTerminalTabIds: (_worktreeId: string, tabs: readonly { id: string }[]) => {
    return new Set(tabs.filter((tab) => mocks.exemptTabIds.has(tab.id)).map((tab) => tab.id))
  }
}))

vi.mock('../output-watchers/terminal-parked-tab-watchers', () => ({
  syncParkedTerminalTabWatchers: vi.fn()
}))
vi.mock('../output-watchers/parked-terminal-tab-coverage', () => ({
  canWatcherCoverParkedTerminalTab: () => mocks.watcherCoverage
}))

vi.mock('../output-watchers/terminal-parked-watcher-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedWatcherRegistryModule>()),
  disposeParkedTerminalWatchersForWorktree: vi.fn()
}))

vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import { invalidateTerminalParkingInputs } from '../terminal-parking-input-events'

const WORKTREE_ID = 'wt-1'

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${WORKTREE_ID}@@session-${id}` } as TerminalTab
}

function hookArgs(shouldMeasureHiddenWorktree: boolean) {
  return {
    worktreeId: WORKTREE_ID,
    terminalTabs: [terminalTab('tab-1'), terminalTab('tab-2')],
    assignments: new Map<string, { groupId: string; isActiveInGroup: boolean }>(),
    isWorktreeActive: false,
    activeTerminalTabId: null as string | null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals: [],
    activationDeferredMountTabIds: null
  }
}

describe('useTerminalTabColdParking exemptions', () => {
  afterEach(() => {
    mocks.exemptTabIds = new Set()
    mocks.watcherCoverage = true
    mocks.storeState.terminalLayoutsByTabId = {}
    mocks.storeState.sleepingAgentSessionsByPaneKey = {}
    mocks.storeState.runtimeStatusByEnvironmentId = new Map()
  })

  // Splits update layout PTYs without changing terminalTabs; that must invalidate exemption memoization.
  it('re-resolves exemptions when only the layout PTYs change', () => {
    const stableArgs = { ...hookArgs(false), coldParkTerminalPanes: true, isForceParked: true }
    const { result, rerender } = renderHook(
      (args: typeof stableArgs) => useTerminalTabColdParking(args),
      { initialProps: stableArgs }
    )
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    mocks.exemptTabIds = new Set(['tab-1'])
    act(() => {
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-1', 'tab-2']))

    mocks.storeState.terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { 'leaf-2': 'pty-local-detached' } }
    }
    act(() => {
      invalidateTerminalParkingInputs(WORKTREE_ID)
      rerender(stableArgs)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })
})
