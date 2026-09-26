// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import type { PaneProcessExit } from './pty-connection-types'
import { TerminalPaneProcessExitPortals } from './TerminalPaneRuntimePortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_ID = 7

function exitRecord(leafId: string): TerminalExitRecord {
  return {
    worktreeId: 'wt-1',
    leafId,
    ptyId: `pty-${leafId}`,
    incarnationId: null,
    exitCode: 3,
    cause: { kind: 'exited', exitCode: 3 },
    exitedAt: 1
  }
}

const processExit: PaneProcessExit = {
  paneId: PANE_ID,
  exitCode: 3,
  reason: 'process-failed',
  startup: null
}

function renderExitedPane({
  isActive,
  onRender = () => {}
}: {
  isActive: boolean
  onRender?: () => void
}) {
  const handleRestartExitedPane = vi.fn()
  const controller = {
    handleCloseExitedPane: vi.fn(),
    handleRestartExitedPane,
    isActive,
    managedPanes: [{ id: PANE_ID, leafId: LEAF_ID, container: document.createElement('div') }],
    paneProcessExitsByPaneId: { [PANE_ID]: processExit }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit portals read only these five controller members.
  const portalsController = controller as unknown as TerminalPaneController
  render(
    <Profiler id="exit-portals" onRender={onRender}>
      <TerminalPaneProcessExitPortals controller={portalsController} />
    </Profiler>
  )
  return { handleRestartExitedPane }
}

describe('a restart main routes to an exited pane', () => {
  beforeEach(() => useAppStore.getState().replaceTerminalExitRecords([]))
  afterEach(() => {
    cleanup()
    useAppStore.getState().replaceTerminalExitRecords([])
  })

  it("runs the pane's own restart once, even in a background tab, and consumes the request", () => {
    useAppStore.getState().replaceTerminalExitRecords([exitRecord(LEAF_ID)])
    const { handleRestartExitedPane } = renderExitedPane({ isActive: false })
    expect(handleRestartExitedPane).not.toHaveBeenCalled()

    act(() => useAppStore.getState().requestExitedTerminalRestart(LEAF_ID))

    expect(handleRestartExitedPane).toHaveBeenCalledTimes(1)
    // Why no focus: the request came from another device, and main focuses the pane when asked to.
    expect(handleRestartExitedPane).toHaveBeenCalledWith(processExit, { focus: false })
    expect(useAppStore.getState().pendingExitedTerminalRestartLeafIds).toEqual({})
  })

  it('runs a request that was waiting when the pane mounted with its exit', () => {
    useAppStore.getState().replaceTerminalExitRecords([exitRecord(LEAF_ID)])
    useAppStore.getState().requestExitedTerminalRestart(LEAF_ID)

    const { handleRestartExitedPane } = renderExitedPane({ isActive: true })

    expect(handleRestartExitedPane).toHaveBeenCalledTimes(1)
  })

  it('does not re-render an exited pane for an exit or a restart request on another leaf', () => {
    useAppStore.getState().replaceTerminalExitRecords([exitRecord(LEAF_ID)])
    const onRender = vi.fn()
    renderExitedPane({ isActive: true, onRender })
    onRender.mockClear()

    act(() =>
      useAppStore
        .getState()
        .replaceTerminalExitRecords([exitRecord(LEAF_ID), exitRecord(OTHER_LEAF_ID)])
    )
    act(() => useAppStore.getState().requestExitedTerminalRestart(OTHER_LEAF_ID))

    expect(onRender).not.toHaveBeenCalled()
  })

  it("leaves another pane's request pending for the pane that holds that leaf", () => {
    useAppStore
      .getState()
      .replaceTerminalExitRecords([exitRecord(LEAF_ID), exitRecord(OTHER_LEAF_ID)])
    const { handleRestartExitedPane } = renderExitedPane({ isActive: true })

    act(() => useAppStore.getState().requestExitedTerminalRestart(OTHER_LEAF_ID))

    expect(handleRestartExitedPane).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingExitedTerminalRestartLeafIds).toEqual({
      [OTHER_LEAF_ID]: true
    })
  })
})
