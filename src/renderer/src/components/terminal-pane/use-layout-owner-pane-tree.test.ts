// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  holdTabPaneTree,
  onTabPaneTreeRedraw
} from '@/runtime/layout-owner-pane-intents'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

const reconcile = vi.hoisted(() => vi.fn(() => false))
vi.mock('./terminal-pane-frame-reconciliation', () => ({
  reconcileMountedPanesToLayout: reconcile
}))

const pairedServer = vi.hoisted(() => ({ mirrors: false }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/paired-server-workspace', () => ({
  pairedServerMirrors: () => () => pairedServer.mirrors
}))

const { useLayoutOwnerPaneTree } = await import('./use-layout-owner-pane-tree')

const layout = (expandedLeafId: string | null): TerminalLayoutSnapshot => ({
  root: { type: 'leaf', leafId: 'leaf-1' },
  activeLeafId: 'leaf-1',
  expandedLeafId
})

function controllerWith(restoredLayout: TerminalLayoutSnapshot): TerminalPaneCloseController {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    restoredLayout,
    isolatedPaneKey: null,
    expandedPaneIdRef: { current: null },
    managerRef: { current: {} },
    closePaneLocally: vi.fn(),
    onCloseTab: vi.fn(),
    persistLayoutSnapshot: vi.fn()
  } as unknown as TerminalPaneCloseController
}

describe('useLayoutOwnerPaneTree', () => {
  beforeEach(() => {
    _resetLayoutOwnerPaneIntentsForTests()
    reconcile.mockClear()
    pairedServer.mirrors = false
  })

  it('leaves a paired server’s tab to its host, even before a remote terminal binds', () => {
    pairedServer.mirrors = true
    renderHook(() => useLayoutOwnerPaneTree(controllerWith(layout(null))))
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('waits while the window’s own pane command holds the tab, then draws main’s tree', () => {
    const release = holdTabPaneTree('tab-1')
    renderHook(() => useLayoutOwnerPaneTree(controllerWith(layout(null))))
    expect(reconcile).not.toHaveBeenCalled()

    act(() => release())

    expect(reconcile).toHaveBeenCalledOnce()
  })

  it('asks for main’s tree again when a zoomed pane collapses', () => {
    const redraws = vi.fn()
    onTabPaneTreeRedraw(redraws)
    const { rerender } = renderHook(
      ({ snapshot }) => useLayoutOwnerPaneTree(controllerWith(snapshot)),
      {
        initialProps: { snapshot: layout('leaf-1') }
      }
    )
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ isExpanded: true }))
    expect(redraws).not.toHaveBeenCalled()

    rerender({ snapshot: layout(null) })

    expect(redraws).toHaveBeenCalledWith('tab-1')
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ isExpanded: false }))
  })
})
