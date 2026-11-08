// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'

const mocks = vi.hoisted(() => {
  const state: {
    tabsByWorktree: Record<string, { id: string }[]>
    unifiedTabsByWorktree: Record<string, { id: string; entityId: string; contentType: string }[]>
  } = {
    tabsByWorktree: {
      'repo::/folder': [{ id: 'tab-parked' }]
    },
    unifiedTabsByWorktree: {}
  }
  return {
    hasRegisteredRuntimeTerminalTab: vi.fn<(tabId: string, worktreeId?: string) => boolean>(),
    requestBackgroundTerminalWorktreeMount: vi.fn(),
    state
  }
})

vi.mock('@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry', () => ({
  hasRegisteredRuntimeTerminalTab: mocks.hasRegisteredRuntimeTerminalTab
}))

vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.requestBackgroundTerminalWorktreeMount
}))

vi.mock('../../store', () => ({
  useAppStore: { getState: () => mocks.state }
}))

import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  hasTerminalPaneSplitMountLease,
  registerTerminalPaneSplitRequestHandler
} from '@/components/terminal-pane/layout/split/terminal-pane-split-request-routing'
import { routeRuntimeTerminalSplitRequest } from './terminal-ui-routing-ipc-bridge'

beforeEach(() => {
  vi.useFakeTimers()
  _resetTerminalPaneSplitRequestRoutingForTests()
  mocks.hasRegisteredRuntimeTerminalTab.mockReset()
  mocks.requestBackgroundTerminalWorktreeMount.mockReset()
  mocks.state.tabsByWorktree = {
    'repo::/folder': [{ id: 'tab-parked' }]
  }
  mocks.state.unifiedTabsByWorktree = {}
})

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
  vi.useRealTimers()
})

describe('runtime terminal split IPC routing', () => {
  it('mounts and replays an unmounted target without focusing it or waiting a fixed delay', () => {
    const received: SplitTerminalPaneDetail[] = []
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValue(false)

    routeRuntimeTerminalSplitRequest({
      tabId: 'tab-parked',
      worktreeId: 'repo::/folder',
      paneRuntimeId: 41,
      sourceLeafId: '11111111-1111-4111-8111-111111111111',
      direction: 'horizontal',
      command: 'codex'
    })

    expect(received).toEqual([])
    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'repo::/folder',
      tabIds: ['tab-parked']
    })
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)

    const unregister = registerTerminalPaneSplitRequestHandler(
      'tab-parked',
      'repo::/folder',
      (detail) => {
        received.push(detail)
      }
    )

    expect(received).toEqual([
      expect.objectContaining({
        tabId: 'tab-parked',
        sourceLeafId: '11111111-1111-4111-8111-111111111111',
        direction: 'horizontal',
        command: 'codex'
      })
    ])
    expect(vi.getTimerCount()).toBe(1)
    unregister()
  })

  it('queues an explicit split while tab ownership is still hydrating', () => {
    const received: SplitTerminalPaneDetail[] = []
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValue(false)
    mocks.state.tabsByWorktree = {}

    routeRuntimeTerminalSplitRequest({
      tabId: 'tab-hydrating',
      worktreeId: 'repo::/folder',
      paneRuntimeId: 4,
      direction: 'vertical'
    })

    expect(mocks.requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'repo::/folder',
      tabIds: ['tab-hydrating']
    })
    expect(hasTerminalPaneSplitMountLease('tab-hydrating', 'repo::/folder')).toBe(true)

    const unregister = registerTerminalPaneSplitRequestHandler(
      'tab-hydrating',
      'repo::/folder',
      (detail) => received.push(detail)
    )
    expect(received).toEqual([
      expect.objectContaining({
        tabId: 'tab-hydrating',
        worktreeId: 'repo::/folder',
        paneRuntimeId: 4,
        direction: 'vertical'
      })
    ])
    unregister()
  })

  it('does not cross worktree ownership when a new main process supplies a stale hint', () => {
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValue(false)

    routeRuntimeTerminalSplitRequest({
      tabId: 'tab-parked',
      worktreeId: 'repo::/other-folder',
      paneRuntimeId: 4,
      direction: 'vertical'
    })

    expect(mocks.requestBackgroundTerminalWorktreeMount).not.toHaveBeenCalled()
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(false)
  })

  it('scopes an already-mounted split event to the requested worktree', () => {
    mocks.state.tabsByWorktree['repo::/other-folder'] = [{ id: 'tab-parked' }]
    mocks.hasRegisteredRuntimeTerminalTab.mockImplementation(
      (_tabId, worktreeId) => worktreeId === 'repo::/folder'
    )
    const receivedHere: SplitTerminalPaneDetail[] = []
    const receivedThere: SplitTerminalPaneDetail[] = []
    const unregisterHere = registerTerminalPaneSplitRequestHandler(
      'tab-parked',
      'repo::/folder',
      (detail) => receivedHere.push(detail)
    )
    const unregisterThere = registerTerminalPaneSplitRequestHandler(
      'tab-parked',
      'repo::/other-folder',
      (detail) => receivedThere.push(detail)
    )

    routeRuntimeTerminalSplitRequest({
      tabId: 'tab-parked',
      worktreeId: 'repo::/folder',
      paneRuntimeId: 4,
      direction: 'vertical'
    })

    expect(receivedHere).toEqual([
      expect.objectContaining({ tabId: 'tab-parked', worktreeId: 'repo::/folder' })
    ])
    expect(receivedThere).toEqual([])
    unregisterHere()
    unregisterThere()
  })

  it('fails closed when a legacy request has duplicate tab owners', () => {
    mocks.hasRegisteredRuntimeTerminalTab.mockReturnValue(false)
    mocks.state.tabsByWorktree['repo::/other-folder'] = [{ id: 'tab-parked' }]

    routeRuntimeTerminalSplitRequest({
      tabId: 'tab-parked',
      paneRuntimeId: 4,
      direction: 'vertical'
    })

    expect(mocks.requestBackgroundTerminalWorktreeMount).not.toHaveBeenCalled()
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(false)
  })
})
