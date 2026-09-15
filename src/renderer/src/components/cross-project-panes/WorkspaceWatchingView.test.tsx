// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceWatchingView } from './WorkspaceWatchingView'

const mocks = vi.hoisted(() => ({
  activateTabAndFocusPane: vi.fn(),
  focusWindowPane: vi.fn(),
  takeWorkspaceViewControl: vi.fn().mockResolvedValue(true),
  isWorkspaceViewController: vi.fn(() => false),
  useWorkspaceViewControlRevision: vi.fn(() => 0)
}))

const state = {
  tabsByWorktree: { worktree: [{ id: 'terminal', entityId: 'tab', ptyId: 'pty' }] },
  terminalLayoutsByTabId: { terminal: { activeLeafId: 'leaf' } },
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  remoteBrowserPageHandlesByPageId: {},
  windowPaneLayout: {
    panes: { pane: { id: 'pane', viewIds: ['view'] } }
  },
  focusWindowPane: mocks.focusWindowPane
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('./workspace-view-control-state', () => ({
  isWorkspaceViewController: mocks.isWorkspaceViewController,
  takeWorkspaceViewControl: mocks.takeWorkspaceViewControl,
  useWorkspaceViewControlRevision: mocks.useWorkspaceViewControlRevision
}))
vi.mock('./WorkspaceTerminalWatcher', () => ({
  WorkspaceTerminalWatcher: () => <div data-testid="terminal-watcher" />
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkspaceWatchingView', () => {
  it('explains read-only control and focuses the Codex TUI after taking control', async () => {
    render(
      <WorkspaceWatchingView
        view={{
          id: 'view',
          tabId: 'tab',
          entityId: 'terminal',
          contentType: 'terminal',
          worktreeId: 'worktree',
          executionHostId: 'local'
        }}
      />
    )

    expect(screen.getByText('Read-only')).toBeTruthy()
    expect(screen.getByText('This session is active in another window.')).toBeTruthy()
    expect(screen.getByTestId('terminal-watcher')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take control here' }))
    })

    expect(mocks.focusWindowPane).toHaveBeenCalledWith('pane', 'view')
    expect(mocks.takeWorkspaceViewControl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'view' })
    )
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab', 'leaf')
  })

  it('shows a recovery message when another window rejects the control request', async () => {
    mocks.takeWorkspaceViewControl.mockResolvedValueOnce(false)
    render(
      <WorkspaceWatchingView
        view={{
          id: 'view',
          tabId: 'tab',
          entityId: 'terminal',
          contentType: 'terminal',
          worktreeId: 'worktree',
          executionHostId: 'local'
        }}
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Take control here' }))
    })

    expect(
      screen.getByText('Control request failed. Try again or close the other window.')
    ).toBeTruthy()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
