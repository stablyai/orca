import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock, inspectRuntimeTerminalProcessMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
// Why the real producer and not a hand-written literal: the point of these cases is that
// the host and the guard agree on one shape, and a literal would keep agreeing after a drift.
import {
  buildAbsentPtyInspection,
  buildPtyProcessInspectionWireResult
} from '../../../../shared/pty-process-inspection-evidence'
import { guardRunningTerminalClose } from './running-terminal-close-guard'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('terminal-tab close on PTY absence evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } } },
      agentStatusByPaneKey: {}
    })
  })

  async function closeTab(): Promise<ReturnType<typeof vi.fn>> {
    const onClose = vi.fn()
    guardRunningTerminalClose({ terminalTabId: 'tab-1', tabLabel: 'npm run dev', onClose })
    await settleProbe()
    return onClose
  }

  /** A layout that still names a leaf the liveness map has dropped — the shape left behind
   *  by a pane that exited, by a restart, and by any tab whose layout outlives its panes. */
  function withStaleLayoutLeaf(): void {
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-stale' } }
      },
      agentStatusByPaneKey: {}
    })
  }

  it('asks before closing when the host lost the route to the pane', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(buildAbsentPtyInspection('unverifiable'))

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes silently on a local exit the provider watched', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(buildAbsentPtyInspection('exited'))

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes silently when the only live pane exited and the layout kept a stale leaf', async () => {
    // The stale id has no owner, so the host answers "could not ask" about it forever. Asking
    // on that would put a dialog in front of every cleanly-exited tab whose layout outlived
    // its panes — daemon and remote panes, and local panes after a restart.
    withStaleLayoutLeaf()
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a'
        ? buildAbsentPtyInspection('exited')
        : buildAbsentPtyInspection('unverifiable', 'no registered provider owns this PTY id')
    )

    const onClose = await closeTab()

    expect(visibleRequest()).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still asks for a layout-only pane that answers with a live child process', async () => {
    // The narrowing above must not close the mounting-pane window: a layout leaf the map has
    // not caught up to can still block the close by answering positively.
    withStaleLayoutLeaf()
    inspectRuntimeTerminalProcessMock.mockImplementation(async (_settings, ptyId: string) =>
      ptyId === 'pty-a'
        ? buildAbsentPtyInspection('exited')
        : buildPtyProcessInspectionWireResult(
            { verdict: 'observed', processName: 'node' },
            { verdict: 'live' }
          )
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks before closing a pane with a live child process', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(
      buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'node' },
        { verdict: 'live' }
      )
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('asks when an in-contact child-process probe is unverifiable', async () => {
    inspectRuntimeTerminalProcessMock.mockResolvedValue(
      buildPtyProcessInspectionWireResult(
        { verdict: 'unverifiable', reason: 'process table scan degraded' },
        { verdict: 'unverifiable', reason: 'process table scan degraded' }
      )
    )

    const onClose = await closeTab()

    expect(visibleRequest()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})
