// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acknowledgeAgents: vi.fn(),
  setActiveWorktree: vi.fn(),
  subscribeStore: vi.fn(() => vi.fn()),
  onRevealAgent: vi.fn(),
  onAckAgent: vi.fn(),
  onPopoutOpenChanged: vi.fn(),
  onSnapshotRequested: vi.fn(),
  getPopoutOpen: vi.fn(async () => false),
  publishSnapshot: vi.fn(async () => undefined),
  offRevealAgent: vi.fn(),
  offAckAgent: vi.fn(),
  offPopoutOpenChanged: vi.fn(),
  offSnapshotRequested: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      acknowledgeAgents: mocks.acknowledgeAgents,
      setActiveWorktree: mocks.setActiveWorktree
    }),
    subscribe: mocks.subscribeStore
  }
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: vi.fn()
}))

import {
  dashboardSnapshotInputsChanged,
  useDashboardPopoutBridge
} from './useDashboardPopoutBridge'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import type { AppState } from '@/store/types'

type DashboardSnapshotWatchState = DashboardSnapshotState & Pick<AppState, 'agentStatusEpoch'>

function makeSnapshotWatchState(): DashboardSnapshotWatchState {
  return {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    agentStatusEpoch: 0
  }
}

function Harness({ enabled }: { enabled: boolean }): null {
  useDashboardPopoutBridge(enabled)
  return null
}

describe('useDashboardPopoutBridge', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.onRevealAgent.mockReturnValue(mocks.offRevealAgent)
    mocks.onAckAgent.mockReturnValue(mocks.offAckAgent)
    mocks.onPopoutOpenChanged.mockReturnValue(mocks.offPopoutOpenChanged)
    mocks.onSnapshotRequested.mockReturnValue(mocks.offSnapshotRequested)
    ;(window as unknown as { api: unknown }).api = {
      dashboard: {
        onRevealAgent: mocks.onRevealAgent,
        onAckAgent: mocks.onAckAgent,
        onPopoutOpenChanged: mocks.onPopoutOpenChanged,
        onSnapshotRequested: mocks.onSnapshotRequested,
        getPopoutOpen: mocks.getPopoutOpen,
        publishSnapshot: mocks.publishSnapshot
      }
    }
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('does not register dashboard or store subscriptions while disabled', async () => {
    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.onRevealAgent).not.toHaveBeenCalled()
    expect(mocks.onAckAgent).not.toHaveBeenCalled()
    expect(mocks.onPopoutOpenChanged).not.toHaveBeenCalled()
    expect(mocks.onSnapshotRequested).not.toHaveBeenCalled()
    expect(mocks.getPopoutOpen).not.toHaveBeenCalled()
    expect(mocks.subscribeStore).not.toHaveBeenCalled()
  })

  it('ignores unrelated store writes while retaining every snapshot input', () => {
    const previousState = makeSnapshotWatchState()
    expect(dashboardSnapshotInputsChanged({ ...previousState }, previousState)).toBe(false)

    const referenceInputs = [
      'repos',
      'worktreesByRepo',
      'tabsByWorktree',
      'agentStatusByPaneKey',
      'retainedAgentsByPaneKey',
      'migrationUnsupportedByPtyId',
      'runtimeAgentOrchestrationByPaneKey',
      'terminalLayoutsByTabId',
      'ptyIdsByTabId',
      'runtimePaneTitlesByTabId',
      'acknowledgedAgentsByPaneKey'
    ] as const
    for (const key of referenceInputs) {
      expect(
        dashboardSnapshotInputsChanged({ ...previousState, [key]: {} }, previousState),
        key
      ).toBe(true)
    }
    expect(
      dashboardSnapshotInputsChanged({ ...previousState, agentStatusEpoch: 1 }, previousState)
    ).toBe(true)
  })

  it('releases every dashboard listener when the experiment is disabled', async () => {
    await act(async () => root.render(<Harness enabled />))

    expect(mocks.onRevealAgent).toHaveBeenCalledTimes(1)
    expect(mocks.onAckAgent).toHaveBeenCalledTimes(1)
    expect(mocks.onPopoutOpenChanged).toHaveBeenCalledTimes(1)
    expect(mocks.onSnapshotRequested).toHaveBeenCalledTimes(1)
    expect(mocks.getPopoutOpen).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.offRevealAgent).toHaveBeenCalledTimes(1)
    expect(mocks.offAckAgent).toHaveBeenCalledTimes(1)
    expect(mocks.offPopoutOpenChanged).toHaveBeenCalledTimes(1)
    expect(mocks.offSnapshotRequested).toHaveBeenCalledTimes(1)
  })
})
