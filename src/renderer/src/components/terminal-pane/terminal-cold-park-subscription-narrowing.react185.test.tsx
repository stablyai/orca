/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKTREE_ID = 'repo::/cold-park-narrowing'
const OTHER_WORKTREE_ID = 'repo::/cold-park-narrowing-other'

const harness = vi.hoisted(() => ({ renders: 0 }))

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create(() => ({
    pendingStartupByTabId: {} as Record<string, unknown>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    runtimeStatusByEnvironmentId: new Map<string, unknown>(),
    runtimePaneTitlesByTabId: {} as Record<string, Record<number, string>>,
    settings: {} as Record<string, unknown>,
    sleepingAgentSessionsByPaneKey: {} as Record<string, unknown>,
    terminalLayoutsByTabId: {} as Record<string, unknown>
  }))
  return { useAppStore }
})

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  syncParkedTerminalTabWatchers: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

import { useAppStore } from '../../store'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const terminalTabs = ['tab-1', 'tab-2'].map(
  (id) => ({ id, ptyId: `${WORKTREE_ID}@@session-${id}` }) as TerminalTab
)
const assignments = new Map<string, { groupId: string; isActiveInGroup: boolean }>()

function sleepingRecord(
  paneKey: string,
  worktreeId: string,
  extra: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return { paneKey, worktreeId, ...extra } as unknown as SleepingAgentSessionRecord
}
const activityTerminalPortals: never[] = []

function ColdParkingHarness(): null {
  harness.renders += 1
  useTerminalTabColdParking({
    worktreeId: WORKTREE_ID,
    terminalTabs,
    assignments,
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals,
    activationDeferredMountTabIds: null
  })
  return null
}

describe('cold-park store subscription narrowing', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    harness.renders = 0
    useAppStore.setState({ pendingStartupByTabId: {}, sleepingAgentSessionsByPaneKey: {} })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<ColdParkingHarness />)
    })
    harness.renders = 0
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    container.remove()
  })

  // Why: these two maps are app-global, so before narrowing any write re-rendered
  // every mounted worktree's overlay layer.
  it('ignores a pending-startup write for another worktree tab', () => {
    act(() => {
      useAppStore.setState({ pendingStartupByTabId: { 'other-tab': { command: 'codex' } } })
    })
    expect(harness.renders).toBe(0)
  })

  it('ignores a sleeping-session write for another worktree', () => {
    act(() => {
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'other-tab:1': sleepingRecord('other-tab:1', OTHER_WORKTREE_ID)
        }
      })
    })
    expect(harness.renders).toBe(0)
  })

  // Why: a blocked record never resumes, so it leaves the exempt set — and the
  // narrowed subscription's compared value — unchanged.
  it('ignores a sleeping-session write this worktree can never resume', () => {
    act(() => {
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'tab-1:1': sleepingRecord('tab-1:1', WORKTREE_ID, {
            automaticResumeBlockedBy: 'legacy-orchestration-worker'
          })
        }
      })
    })
    expect(harness.renders).toBe(0)
  })

  it('still re-renders when this worktree gains a pending startup', () => {
    act(() => {
      useAppStore.setState({
        pendingStartupByTabId: { 'tab-1': { command: 'claude' }, 'other-tab': { command: 'codex' } }
      })
    })
    expect(harness.renders).toBeGreaterThan(0)
  })

  it('still re-renders when this worktree gains a sleeping-session record', () => {
    act(() => {
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'tab-1:1': sleepingRecord('tab-1:1', WORKTREE_ID)
        }
      })
    })
    expect(harness.renders).toBeGreaterThan(0)
  })
})
