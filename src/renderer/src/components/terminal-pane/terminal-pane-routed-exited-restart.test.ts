// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import type { PaneProcessExit } from './pty-connection-types'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'

const { connectPanePty } = vi.hoisted(() => ({
  connectPanePty: vi.fn(() => ({ dispose: vi.fn() }))
}))
vi.mock('./pty-connection', () => ({ connectPanePty }))

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

function renderPaneWithExitedLeaf() {
  const manager = {
    getPanes: () => [{ id: PANE_ID, leafId: LEAF_ID }],
    setActivePane: vi.fn()
  }
  const panePtyBindings = new Map<number, unknown>()
  const explicit: Record<string, unknown> = {
    managerRef: { current: manager },
    panePtyBindingsRef: { current: panePtyBindings },
    paneTransportsRef: { current: new Map() },
    savedLayout: {},
    pendingCodexPaneRestartIds: {},
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/repo'
  }
  // Why stable stubs: the hook's callbacks and effects key on these identities.
  const stubs = new Map<PropertyKey, unknown>()
  const controllerFor = (fields: Record<string, unknown>): TerminalPaneCloseController => {
    const proxy = new Proxy(fields, {
      get: (target, key) => {
        if (typeof key === 'string' && key in target) {
          return target[key]
        }
        if (!stubs.has(key)) {
          stubs.set(key, key.toString().endsWith('Ref') ? { current: null } : vi.fn())
        }
        return stubs.get(key)
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy answers every controller member; the restart path reads only the explicit fields, refs and callbacks it supplies.
    return proxy as unknown as TerminalPaneCloseController
  }
  const hook = renderHook(() => {
    const [paneProcessExitsByPaneId, setPaneProcessExitsByPaneId] = useState<
      Record<number, PaneProcessExit>
    >({ [PANE_ID]: processExit })
    const controller = controllerFor({
      ...explicit,
      paneProcessExitsByPaneId,
      setPaneProcessExitsByPaneId
    })
    return { actions: useTerminalPaneProcessExitActions(controller), paneProcessExitsByPaneId }
  })
  return { hook, manager, panePtyBindings }
}

describe('a restart main routes to a mounted pane', () => {
  beforeEach(() => {
    connectPanePty.mockClear()
    useAppStore.getState().replaceTerminalExitRecords([])
  })
  afterEach(() => {
    cleanup()
    useAppStore.getState().replaceTerminalExitRecords([])
  })

  it("runs the pane's own plain-shell restart once and consumes the request", () => {
    useAppStore.getState().replaceTerminalExitRecords([exitRecord(LEAF_ID)])
    const { hook, manager, panePtyBindings } = renderPaneWithExitedLeaf()
    expect(connectPanePty).not.toHaveBeenCalled()

    act(() => useAppStore.getState().requestExitedTerminalRestart(LEAF_ID))

    expect(connectPanePty).toHaveBeenCalledTimes(1)
    expect(connectPanePty).toHaveBeenCalledWith(
      expect.objectContaining({ id: PANE_ID, leafId: LEAF_ID }),
      manager,
      expect.objectContaining({ startup: null })
    )
    expect(panePtyBindings.has(PANE_ID)).toBe(true)
    expect(hook.result.current.paneProcessExitsByPaneId).toEqual({})
    expect(useAppStore.getState().pendingExitedTerminalRestartLeafIds).toEqual({})

    hook.rerender()
    expect(connectPanePty).toHaveBeenCalledTimes(1)
  })

  it("leaves another pane's request pending for the pane that holds that leaf", () => {
    useAppStore
      .getState()
      .replaceTerminalExitRecords([exitRecord(LEAF_ID), exitRecord(OTHER_LEAF_ID)])
    renderPaneWithExitedLeaf()

    act(() => useAppStore.getState().requestExitedTerminalRestart(OTHER_LEAF_ID))

    expect(connectPanePty).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingExitedTerminalRestartLeafIds).toEqual({
      [OTHER_LEAF_ID]: true
    })
  })
})
