// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../../../shared/crash-reporting'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const harness = vi.hoisted(() => ({
  state: {
    pendingStartupByTabId: {},
    ptyIdsByTabId: {},
    runtimeStatusByEnvironmentId: new Map(),
    runtimePaneTitlesByTabId: {},
    settings: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    repos: []
  },
  breadcrumb: vi.fn<(name: string, data?: CrashReportBreadcrumbData) => void>(),
  syncWatchers: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof harness.state) => unknown) => selector(harness.state),
    { getState: () => harness.state }
  )
}))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  resolveParkedTerminalPaneCandidates: () => [],
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: harness.syncWatchers
}))

// Isolate the worktree verdict from the separate per-tab aging policy.
vi.mock('./terminal-parking-e2e-overrides', () => ({
  getTerminalParkingPolicyOverrides: () => ({ coldParkDelayMs: 24 * 60 * 60_000 })
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: harness.breadcrumb
}))

import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'
import {
  TERMINAL_TAB_PARK_FLIP_BURST_LIMIT,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS
} from './terminal-park-verdict-flip-telemetry'

const WORKTREE_ID = 'retention-churn'
const TAB_ID = 'restorable-ssh-tab'
const EXEMPT_TAB_ID = 'local-live-shell'
const STEP_MS = 4_000

function terminalTab(id: string, ptyId: string): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

type ParkingArgs = Parameters<typeof useTerminalTabColdParking>[0]

function parkingArgs(isForceParked = false): ParkingArgs {
  return {
    worktreeId: WORKTREE_ID,
    terminalTabs: [
      terminalTab(TAB_ID, 'ssh:host@@session-1'),
      terminalTab(EXEMPT_TAB_ID, 'local-fail-open-pty')
    ],
    assignments: new Map(),
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    isForceParked,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: []
  }
}

function churn(
  rerender: (args: ParkingArgs) => void,
  args: ParkingArgs,
  flips = 13,
  stepMs = STEP_MS
): void {
  for (let flip = 1; flip <= flips; flip += 1) {
    act(() => {
      vi.advanceTimersByTime(stepMs)
      rerender({ ...args, coldParkTerminalPanes: flip % 2 === 1 })
    })
  }
}

describe('retention force-parking and churn pins', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    harness.breadcrumb.mockClear()
    harness.syncWatchers.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  it('releases an earned sustained pin when forced, preserving the live-shell exemption', () => {
    const args = parkingArgs()
    const { result, rerender } = renderHook(useTerminalTabColdParking, { initialProps: args })
    churn(rerender, args)
    expect(result.current.size).toBe(0)
    expect(harness.breadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window', pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS })
    )

    act(() => rerender({ ...args, coldParkTerminalPanes: true, isForceParked: true }))

    expect(result.current).toEqual(new Set([TAB_ID]))
    expect(harness.syncWatchers).toHaveBeenLastCalledWith(
      expect.objectContaining({ parkedTabIds: new Set([TAB_ID]) })
    )
  })

  it('does not rearm sustained pins while forced and resumes damping after force-parking ends', () => {
    const args = parkingArgs(true)
    const { result, rerender } = renderHook(useTerminalTabColdParking, { initialProps: args })
    for (let flip = 1; flip <= 30; flip += 1) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS)
        rerender({ ...args, coldParkTerminalPanes: flip % 2 === 1 })
      })
      expect(result.current).toEqual(flip % 2 === 1 ? new Set([TAB_ID]) : new Set())
    }
    expect(harness.breadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window' })
    )
    expect(harness.breadcrumb.mock.calls.some(([, data]) => data?.pinnedForMs !== undefined)).toBe(
      false
    )

    act(() => vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_WINDOW_MS))
    churn(rerender, { ...args, isForceParked: false })
    expect(result.current.size).toBe(0)
    expect(harness.breadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'window', pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS })
    )
  })

  it.each([false, true])('preserves the burst deadline with initial force-parking %s', (forced) => {
    const args = parkingArgs(forced)
    const { result, rerender } = renderHook(useTerminalTabColdParking, { initialProps: args })
    churn(rerender, args, TERMINAL_TAB_PARK_FLIP_BURST_LIMIT, 10)
    expect(result.current.size).toBe(0)
    expect(harness.breadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ trigger: 'burst', pinnedForMs: TERMINAL_TAB_PARK_FLIP_WINDOW_MS })
    )

    act(() => {
      vi.advanceTimersByTime(10_000)
      rerender({ ...args, coldParkTerminalPanes: true, isForceParked: true })
    })
    expect(result.current.size).toBe(0)
    act(() => vi.advanceTimersByTime(TERMINAL_TAB_PARK_FLIP_WINDOW_MS - 10_000))
    expect(result.current).toEqual(new Set([TAB_ID]))
  })
})
