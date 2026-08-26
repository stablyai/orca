// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'

const mocks = vi.hoisted(() => ({
  resolveSplitCwd: vi.fn(),
  runQuickCommandInNewTab: vi.fn()
}))

vi.mock('./resolve-split-cwd', () => ({ resolveSplitCwd: mocks.resolveSplitCwd }))
vi.mock('@/lib/run-quick-command-in-new-tab', () => ({
  runQuickCommandInNewTab: mocks.runQuickCommandInNewTab
}))
vi.mock('./use-terminal-pane-split-actions', () => ({
  useTerminalPaneSplitActions: () => ({ onSplitRight: vi.fn(), onSplitDown: vi.fn() })
}))
vi.mock('./use-terminal-context-menu-trigger', () => ({
  useTerminalContextMenuTrigger: () => ({
    open: false,
    setOpen: vi.fn(),
    point: { x: 0, y: 0 },
    menuOpenedAtRef: { current: 0 },
    onContextMenuCapture: vi.fn(),
    onPaneTitleContextMenu: vi.fn()
  })
}))

function renderContextMenuHook(cwd: { cwd: string; confirmed: boolean } | null) {
  const pane = {
    id: 7,
    leafId: 'leaf-7',
    container: document.createElement('div'),
    terminal: { focus: vi.fn(), selectAll: vi.fn(), getSelection: vi.fn(() => '') }
  }
  const paneCwdMap = new Map(cwd ? [[pane.id, cwd]] : [])
  const transport = { getPtyId: vi.fn(() => 'pty-7'), sendInput: vi.fn(() => true) }
  const view = renderHook(() =>
    useTerminalPaneContextMenu({
      managerRef: {
        current: { getPanes: () => [pane], getActivePane: () => pane }
      } as never,
      paneTransportsRef: { current: new Map([[pane.id, transport]]) } as never,
      paneCwdRef: { current: paneCwdMap } as never,
      containerRef: { current: document.createElement('div') },
      tabId: 'tab-1',
      worktreeId: 'worktree-1',
      groupId: 'group-1',
      fallbackCwd: '/repo',
      toggleExpandPane: vi.fn(),
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: vi.fn(),
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      onPasteError: vi.fn(),
      onAgentSessionForkReady: vi.fn(),
      onAgentSessionContinuationReady: vi.fn(),
      forceBracketedMultilineTextPaste: false,
      rightClickToPaste: false
    })
  )
  return { view, paneCwdMap, transport }
}

const backgroundCommand = {
  id: 'test',
  label: 'Test',
  command: 'pnpm test',
  appendEnter: false,
  openInBackground: true
} as const

describe('useTerminalPaneContextMenu background Quick Commands', () => {
  beforeEach(() => {
    mocks.resolveSplitCwd.mockReset()
    mocks.runQuickCommandInNewTab.mockReset()
  })

  it('resolves an unconfirmed pane cwd through the shared split resolver', async () => {
    mocks.resolveSplitCwd.mockResolvedValue('/repo/packages/app')
    const { view, paneCwdMap, transport } = renderContextMenuHook({
      cwd: '/stale',
      confirmed: false
    })

    act(() => view.result.current.onQuickCommand(backgroundCommand, 'local\0test'))

    expect(mocks.resolveSplitCwd).toHaveBeenCalledWith({
      paneCwdMap,
      sourcePaneId: 7,
      sourcePtyId: 'pty-7',
      fallbackCwd: '/repo'
    })
    expect(transport.getPtyId).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(mocks.runQuickCommandInNewTab).toHaveBeenCalledWith({
        command: backgroundCommand,
        worktreeId: 'worktree-1',
        groupId: 'group-1',
        historyId: 'local\0test',
        initialCwd: '/repo/packages/app'
      })
    )
  })

  it('uses a confirmed pane cwd without an asynchronous provider lookup', () => {
    const { view, transport } = renderContextMenuHook({
      cwd: 'C:\\repo\\packages\\app',
      confirmed: true
    })

    act(() => view.result.current.onQuickCommand(backgroundCommand, 'local\0test'))

    expect(mocks.resolveSplitCwd).not.toHaveBeenCalled()
    expect(transport.getPtyId).not.toHaveBeenCalled()
    expect(mocks.runQuickCommandInNewTab).toHaveBeenCalledWith({
      command: backgroundCommand,
      worktreeId: 'worktree-1',
      groupId: 'group-1',
      historyId: 'local\0test',
      initialCwd: 'C:\\repo\\packages\\app'
    })
  })
})
