// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyRunningWorkProbe } from '../../../../../../shared/terminal/pty/lifecycle/pty-running-work-probe'
import { useTerminalPaneCloseActions } from './use-terminal-pane-close-actions'

const mocks = vi.hoisted(() => ({
  probePtyRunningWork: vi.fn(),
  storeState: {
    settings: undefined,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: new Map(),
    setCacheTimerStartedAt: vi.fn(),
    dropAgentStatus: vi.fn()
  }
}))

vi.mock('../../../terminal/tab-lifecycle/pty-running-work-probe', () => ({
  probePtyRunningWork: (...args: unknown[]) => mocks.probePtyRunningWork(...args)
}))
// The layout-owner RPC has no window.api under happy-dom; close locally as builds without it do.
vi.mock('./layout-owner-pane-close-command', () => ({
  sendUserPaneCloseToLayoutOwner: () => false
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.storeState } }))

afterEach(cleanup)

// makePaneKey rejects leaf ids that are not UUIDs.
const LEAF_IDS = ['6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5', '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d']

function makeController(options: { panes: number }) {
  const manager = {
    getPanes: () =>
      Array.from({ length: options.panes }, (_, id) => ({ id, leafId: LEAF_IDS[id] })),
    getLeafId: (paneId: number) => LEAF_IDS[paneId],
    getActivePane: () => ({ id: 0, leafId: LEAF_IDS[0] }),
    closePane: vi.fn()
  }
  // Object.create returns any so the probe-path surface can be stubbed without an as cast.
  const controller: Parameters<typeof useTerminalPaneCloseActions>[0] = Object.assign(
    Object.create(null),
    {
      clearSessionRestoredBannerForPane: vi.fn(),
      managerRef: { current: manager },
      onCloseTab: vi.fn(),
      paneTransportsRef: { current: new Map([[1, { getPtyId: () => 'pty-1' }]]) },
      pendingCloseConfirmation: null,
      setPendingCloseConfirmation: vi.fn(),
      setTerminalErrorsByPaneId: vi.fn(),
      syncPanePtyLayoutBinding: vi.fn(),
      syncPanePtyLayoutBindingForLeaf: vi.fn(),
      tabId: 'tab-1',
      updateSettings: vi.fn(),
      worktreeId: 'wt-1'
    }
  )
  return { controller, manager }
}

function makeProbe(
  verdict: PtyRunningWorkProbe['verdict'],
  remote: boolean
): PtyRunningWorkProbe[] {
  return [{ ptyId: 'pty-1', verdict, timedOut: false, remote }]
}

async function flushProbe(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('handleRequestClosePane', () => {
  it('closes a local pane without confirming when the running-work probe is unverifiable', async () => {
    mocks.probePtyRunningWork.mockResolvedValue(makeProbe('unverifiable', false))
    const { controller, manager } = makeController({ panes: 2 })
    const { result } = renderHook(() => useTerminalPaneCloseActions(controller))

    act(() => result.current.handleRequestClosePane(1))
    await flushProbe()

    expect(controller.setPendingCloseConfirmation).not.toHaveBeenCalled()
    expect(manager.closePane).toHaveBeenCalledWith(1)
  })

  it('confirms when the probe reports live work', async () => {
    mocks.probePtyRunningWork.mockResolvedValue(makeProbe('live', false))
    const { controller, manager } = makeController({ panes: 2 })
    const { result } = renderHook(() => useTerminalPaneCloseActions(controller))

    act(() => result.current.handleRequestClosePane(1))
    await flushProbe()

    expect(controller.setPendingCloseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 1 })
    )
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('confirms a remote pane the probe cannot verify', async () => {
    mocks.probePtyRunningWork.mockResolvedValue(makeProbe('unverifiable', true))
    const { controller, manager } = makeController({ panes: 2 })
    const { result } = renderHook(() => useTerminalPaneCloseActions(controller))

    act(() => result.current.handleRequestClosePane(1))
    await flushProbe()

    expect(controller.setPendingCloseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 1 })
    )
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('confirms when the pane restarted while the probe was out', async () => {
    let answer: (probes: PtyRunningWorkProbe[]) => void = () => {}
    mocks.probePtyRunningWork.mockReturnValue(
      new Promise<PtyRunningWorkProbe[]>((resolve) => {
        answer = resolve
      })
    )
    const { controller, manager } = makeController({ panes: 2 })
    const { result } = renderHook(() => useTerminalPaneCloseActions(controller))

    act(() => result.current.handleRequestClosePane(1))
    // The answer below is about the PTY a restart has already replaced.
    const replacement = Object.assign(Object.create(null), { getPtyId: () => 'pty-2' })
    controller.paneTransportsRef.current.set(1, replacement)
    await act(async () => {
      answer(makeProbe('unverifiable', false))
    })

    expect(controller.setPendingCloseConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 1 })
    )
    expect(manager.closePane).not.toHaveBeenCalled()
  })
})
