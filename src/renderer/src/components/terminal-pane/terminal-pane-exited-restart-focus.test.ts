// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneProcessExit } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'

const { connectPanePty } = vi.hoisted(() => ({
  connectPanePty: vi.fn(() => ({ dispose: vi.fn() }))
}))
vi.mock('./pty-connection', () => ({ connectPanePty }))

const PANE_ID = 7

const processExit: PaneProcessExit = {
  paneId: PANE_ID,
  exitCode: 3,
  reason: 'process-failed',
  startup: null
}

function renderExitActions() {
  const pane = { id: PANE_ID, leafId: '11111111-1111-4111-8111-111111111111' }
  const manager = { getPanes: () => [pane], setActivePane: vi.fn() }
  const controller = new Proxy(
    {
      managerRef: { current: manager },
      paneTransportsRef: { current: new Map() },
      panePtyBindingsRef: { current: new Map() },
      pendingCodexPaneRestartIds: {},
      savedLayout: {},
      setPaneProcessExitsByPaneId: vi.fn(),
      setTerminalErrorsByPaneId: vi.fn(),
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    },
    // Why: every other controller member is a callback or ref the restart only forwards.
    { get: (target, key) => (key in target ? Reflect.get(target, key) : vi.fn()) }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy answers every controller member; the restart path reads the listed ones and forwards the rest.
  const typedController = controller as unknown as TerminalPaneCloseController
  const { result } = renderHook(() => useTerminalPaneProcessExitActions(typedController))
  return { result, manager }
}

describe('restarting an exited pane', () => {
  it('focuses the pane for its own Restart', () => {
    const { result, manager } = renderExitActions()

    result.current.handleRestartExitedPane(processExit)

    expect(connectPanePty).toHaveBeenCalledTimes(1)
    expect(manager.setActivePane).toHaveBeenCalledWith(PANE_ID, { focus: true })
  })

  it('leaves focus alone for a restart another device asked for', () => {
    connectPanePty.mockClear()
    const { result, manager } = renderExitActions()

    result.current.handleRestartExitedPane(processExit, { focus: false })

    expect(connectPanePty).toHaveBeenCalledTimes(1)
    expect(manager.setActivePane).not.toHaveBeenCalled()
  })
})
