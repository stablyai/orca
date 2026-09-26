// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PaneProcessExit } from './pty-connection-types'
import { TerminalPaneProcessExitPortals } from './TerminalPaneRuntimePortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_ID = 7

const processExit: PaneProcessExit = {
  paneId: PANE_ID,
  exitCode: 3,
  reason: 'process-failed',
  startup: null
}

type PortalState = {
  isActive: boolean
  ptyIdsByLeafId?: Record<string, string>
  exited?: boolean
}

function makeController(state: PortalState, actions: ReturnType<typeof makeActions>) {
  const controller = {
    ...actions,
    isActive: state.isActive,
    managedPanes: [{ id: PANE_ID, leafId: LEAF_ID, container: document.createElement('div') }],
    paneProcessExitsByPaneId: state.exited === false ? {} : { [PANE_ID]: processExit },
    savedLayout: state.ptyIdsByLeafId ? { ptyIdsByLeafId: state.ptyIdsByLeafId } : {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit portals read only these controller members.
  return controller as unknown as TerminalPaneController
}

function makeActions() {
  return {
    handleAttachExitedPane: vi.fn(),
    handleCloseExitedPane: vi.fn(),
    handleRestartExitedPane: vi.fn()
  }
}

function renderExitedPane(initial: PortalState) {
  const actions = makeActions()
  const view = render(
    <TerminalPaneProcessExitPortals controller={makeController(initial, actions)} />
  )
  const update = (state: PortalState): void =>
    view.rerender(<TerminalPaneProcessExitPortals controller={makeController(state, actions)} />)
  return { actions, update }
}

describe('an exited pane whose leaf main restarted', () => {
  afterEach(() => {
    cleanup()
    useAppStore.getState().replaceTerminalExitRecords([])
  })

  it('attaches once when its leaf binds a new process, even in a background tab', () => {
    const { actions, update } = renderExitedPane({ isActive: false })
    expect(actions.handleAttachExitedPane).not.toHaveBeenCalled()

    update({ isActive: false, ptyIdsByLeafId: { [LEAF_ID]: 'pty-restarted' } })
    update({ isActive: false, ptyIdsByLeafId: { [LEAF_ID]: 'pty-restarted' } })

    expect(actions.handleAttachExitedPane).toHaveBeenCalledTimes(1)
    expect(actions.handleAttachExitedPane).toHaveBeenCalledWith(processExit)
    expect(actions.handleRestartExitedPane).not.toHaveBeenCalled()
  })

  it('does not attach to the dead process a remounted pane still names', () => {
    const { actions, update } = renderExitedPane({
      isActive: true,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-dead' }
    })

    update({ isActive: true, ptyIdsByLeafId: { [LEAF_ID]: 'pty-dead' } })
    update({ isActive: true })

    expect(actions.handleAttachExitedPane).not.toHaveBeenCalled()

    update({ isActive: true, ptyIdsByLeafId: { [LEAF_ID]: 'pty-restarted' } })

    expect(actions.handleAttachExitedPane).toHaveBeenCalledTimes(1)
  })

  it('never attaches when its record ends by a close or a worktree removal', () => {
    useAppStore.getState().replaceTerminalExitRecords([
      {
        worktreeId: 'wt-1',
        leafId: LEAF_ID,
        ptyId: 'pty-dead',
        incarnationId: null,
        exitCode: 3,
        cause: { kind: 'exited', exitCode: 3 },
        exitedAt: 1
      }
    ])
    const { actions, update } = renderExitedPane({ isActive: true })

    // Why: a record also ends when its leaf leaves the session; only a new binding is a restart.
    act(() => useAppStore.getState().replaceTerminalExitRecords([]))
    update({ isActive: true })
    update({ isActive: true, exited: false })

    expect(actions.handleAttachExitedPane).not.toHaveBeenCalled()
  })

  it("does not attach twice after the pane's own Restart cleared its exit", () => {
    const { actions, update } = renderExitedPane({ isActive: true })

    update({ isActive: true, exited: false })
    update({ isActive: true, exited: false, ptyIdsByLeafId: { [LEAF_ID]: 'pty-own-restart' } })

    expect(actions.handleAttachExitedPane).not.toHaveBeenCalled()
  })
})
