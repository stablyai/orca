// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import * as paneTree from '../../../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { useHostTerminalLayoutReconciliation } from './use-host-terminal-layout-reconciliation'

const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it('keeps mounted retained-layout consumers idle on scalar and other-pane publications', () => {
  useAppStore.setState({ ...initial, terminalPaneStartsByPaneKey: {} }, true)
  const traversals = vi.spyOn(paneTree, 'collectLeafIds')
  const leafId = '11111111-1111-4111-8111-111111111111'
  // No manager mounts in this test; the production hook still subscribes to its exact start selector.
  const args: Parameters<typeof useHostTerminalLayoutReconciliation>[0] = {
    tabId: 'target',
    isActive: false,
    paneCount: 1,
    managerRef: { current: null },
    paneTransportsRef: { current: new Map() },
    hostRetiredLeafIdsRef: { current: new Set() },
    hostLayoutLeafIdsRef: { current: new Set() },
    persistLayoutSnapshot: vi.fn(),
    executeClosePane: vi.fn(),
    ptyRecoveryStatesByPaneId: {},
    restoredLayout: {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }
  }
  let renders = 0
  renderHook(() => {
    renders += 1
    useHostTerminalLayoutReconciliation(args)
  })
  const mounted = renders
  traversals.mockClear()
  try {
    act(() => useAppStore.setState({ activeWorktreeId: 'unrelated-workspace' }))
    act(() =>
      useAppStore.setState({
        terminalPaneStartsByPaneKey: {
          [`other:${leafId}`]: {
            status: 'starting',
            retainedTerminalStart: {
              worktreeId: 'other-workspace',
              executionHostId: 'ssh:other',
              runtimeId: 'other-runtime',
              tabId: 'other',
              leafId,
              bindingGeneration: 0,
              startSequence: 1,
              status: 'starting',
              reason: ''
            }
          }
        }
      })
    )
    expect(renders).toBe(mounted)
    expect(traversals).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState((state) => ({
        terminalPaneStartsByPaneKey: {
          ...state.terminalPaneStartsByPaneKey,
          [`target:${leafId}`]: {
            status: 'failed',
            retainedTerminalStart: {
              worktreeId: 'workspace',
              executionHostId: 'local',
              runtimeId: 'runtime',
              tabId: 'target',
              leafId,
              bindingGeneration: 0,
              startSequence: 2,
              status: 'failed',
              reason: 'Shell failed.'
            }
          }
        }
      }))
    )
    expect(renders).toBe(mounted + 1)
    expect(traversals).not.toHaveBeenCalled()
  } finally {
    traversals.mockRestore()
  }
})
