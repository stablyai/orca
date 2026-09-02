/** @vitest-environment happy-dom */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPaneCanvasWorkspaceState } from './pane-canvas-layout-state'
import { paneCanvasStorageKey } from './pane-canvas-layout-storage'
import { usePaneCanvasWorkspaceState } from './use-pane-canvas-workspace-state'

describe('usePaneCanvasWorkspaceState', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('does not reload geometry when only the terminal-id array identity changes', () => {
    const { result, rerender } = renderHook(
      ({ terminalTabIds }: { terminalTabIds: string[] }) =>
        usePaneCanvasWorkspaceState({ ownerKey: 'owner-1', terminalTabIds }),
      { initialProps: { terminalTabIds: ['terminal-1'] } }
    )

    act(() => {
      result.current.updateCanvasState((current) => ({
        ...current,
        boundsByTerminalTabId: {
          ...current.boundsByTerminalTabId,
          'terminal-1': { ...current.boundsByTerminalTabId['terminal-1'], x: 144 }
        }
      }))
    })

    const stalePersisted = createPaneCanvasWorkspaceState(['terminal-1'])
    stalePersisted.boundsByTerminalTabId['terminal-1'].x = 999
    localStorage.setItem(paneCanvasStorageKey('owner-1'), JSON.stringify(stalePersisted))

    rerender({ terminalTabIds: ['terminal-1'] })

    expect(result.current.canvasState.boundsByTerminalTabId['terminal-1'].x).toBe(144)
  })

  it('reconciles persisted geometry when the terminal ids actually change', () => {
    const { result, rerender } = renderHook(
      ({ terminalTabIds }: { terminalTabIds: string[] }) =>
        usePaneCanvasWorkspaceState({ ownerKey: 'owner-2', terminalTabIds }),
      { initialProps: { terminalTabIds: ['terminal-1'] } }
    )

    rerender({ terminalTabIds: ['terminal-1', 'terminal-2'] })

    expect(Object.keys(result.current.canvasState.boundsByTerminalTabId)).toEqual([
      'terminal-1',
      'terminal-2'
    ])
  })
})
