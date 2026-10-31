// @vitest-environment happy-dom

import type { CSSProperties, ReactNode } from 'react'

import { tmpdir } from 'node:os'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  // Keep callback identities stable so companion-board effects track real state changes only.
  closeWorkspaceBoard: vi.fn(),
  dropOwnerRef: vi.fn(),
  panel: {
    workspaceBoardOpen: false,
    workspaceBoardRenderedOpen: true,
    workspaceBoardDragPreviewOpen: false
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({
    containerRef: { current: null },
    isResizing: false,
    onResizeStart: vi.fn()
  })
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./SidebarHeader', () => ({ default: () => <div data-testid="sidebar-header" /> }))

vi.mock('./SidebarAgentsList', () => ({
  default: ({ query }: { query: string }) => (
    <div data-testid="sidebar-agents-list" data-query={query} />
  )
}))

vi.mock('./SidebarNav', () => ({
  default: () => <div data-testid="sidebar-nav" />
}))

vi.mock('./SetupScriptPromptCard', () => ({
  default: () => <div data-testid="setup-script-prompt-card" />
}))

vi.mock('./WorktreeList', () => ({
  default: () => <div data-testid="worktree-list" />
}))

vi.mock('./WslMovedProjectsSection', () => ({ default: () => null }))

vi.mock('./SidebarToolbar', () => ({
  default: () => <div data-testid="sidebar-toolbar" />
}))

vi.mock('./WorkspaceKanbanDrawer', () => ({
  default: ({
    leftSidebarStyle,
    statusBarVisible
  }: {
    leftSidebarStyle?: CSSProperties
    statusBarVisible: boolean
  }) => (
    <div
      data-testid="workspace-kanban-drawer"
      data-status-bar-visible={String(statusBarVisible)}
      style={leftSidebarStyle}
    />
  )
}))

vi.mock('./useSidebarProjectDrop', () => ({
  useSidebarProjectDrop: () => ({
    dropOwnerRef: mocks.dropOwnerRef,
    dropHandlers: {},
    affordance: { visible: false }
  })
}))

vi.mock('./useWorkspaceBoardPanel', () => ({
  useWorkspaceBoardPanel: () => ({
    ...mocks.panel,
    workspaceBoardMenuOpen: false,
    toggleWorkspaceBoard: vi.fn(),
    handleWorkspaceBoardOpenChange: vi.fn(),
    setWorkspaceBoardMenuOpen: vi.fn(),
    closeWorkspaceBoard: mocks.closeWorkspaceBoard,
    previewWorkspaceBoardFromDrag: vi.fn(),
    solidifyWorkspaceBoardFromDrag: vi.fn(),
    cancelWorkspaceBoardDragPreview: vi.fn()
  })
}))

import Sidebar from './index'

function setSidebarState(settings: GlobalSettings, statusBarVisible = true): void {
  mocks.state = {
    activeModal: null,
    agentDashboardDrawerOpen: false,
    setAgentDashboardDrawerOpen: vi.fn(),
    fetchAllWorktrees: vi.fn(),
    repos: [],
    detectedWorktreesByRepo: {},
    setSidebarWidth: vi.fn(),
    settings,
    sidebarOpen: true,
    sidebarWidth: 320,
    statusBarVisible
  }
}

function sidebarElement(): ReactNode {
  return (
    <Sidebar worktreeScrollOffsetRef={{ current: 0 }} worktreeScrollAnchorRef={{ current: null }} />
  )
}

beforeEach(() => {
  mocks.closeWorkspaceBoard.mockClear()
  mocks.dropOwnerRef.mockClear()
  mocks.panel = {
    workspaceBoardOpen: false,
    workspaceBoardRenderedOpen: true,
    workspaceBoardDragPreviewOpen: false
  }
})

afterEach(cleanup)

describe('Sidebar', () => {
  it('explains the incomplete workspace list until startup discovery finishes', () => {
    vi.useFakeTimers()
    try {
      setSidebarState(getDefaultSettings(tmpdir()))
      mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: false }
      const view = render(sidebarElement())
      expect(view.queryByRole('status')).toBeNull()
      act(() => vi.advanceTimersByTime(200))
      expect(view.getByRole('status').textContent).toContain('Discovering workspaces')
      expect(view.getByRole('status').textContent).toContain('More workspaces may appear')
      mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: true }
      view.rerender(sidebarElement())
      expect(view.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a full worktree scan while the startup session is hydrating', () => {
    setSidebarState(getDefaultSettings(tmpdir()))
    const fetchAllWorktrees = vi.fn().mockResolvedValue(undefined)
    mocks.state = {
      ...mocks.state,
      fetchAllWorktrees,
      repos: [],
      startupWorktreeRefreshCompleted: false
    }
    const view = render(sidebarElement())

    mocks.state = { ...mocks.state, repos: [{ id: 'repo-a' }] }
    view.rerender(sidebarElement())
    expect(fetchAllWorktrees).not.toHaveBeenCalled()

    mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: true }
    view.rerender(sidebarElement())
    expect(fetchAllWorktrees).not.toHaveBeenCalled()

    mocks.state = { ...mocks.state, repos: [{ id: 'repo-a' }, { id: 'repo-b' }] }
    view.rerender(sidebarElement())
    expect(fetchAllWorktrees).toHaveBeenCalledTimes(1)
  })

  it('does not scan all hosts when runtime connection status flaps', () => {
    setSidebarState(getDefaultSettings(tmpdir()))
    const fetchAllWorktrees = vi.fn().mockResolvedValue(undefined)
    mocks.state = {
      ...mocks.state,
      fetchAllWorktrees,
      runtimeStatusByEnvironmentId: new Map(),
      startupWorktreeRefreshCompleted: true
    }
    const view = render(sidebarElement())

    for (let index = 0; index < 5; index += 1) {
      mocks.state = {
        ...mocks.state,
        runtimeStatusByEnvironmentId: new Map([
          ['runtime-a', { status: index % 2 === 0 ? 'connected' : null }]
        ])
      }
      view.rerender(sidebarElement())
    }

    expect(fetchAllWorktrees).not.toHaveBeenCalled()
  })

  it('closes the dashboard drawer when the dashboard experiment is disabled', async () => {
    setSidebarState({
      ...getDefaultSettings(tmpdir()),
      experimentalAgentDashboardPopout: false
    })
    const setAgentDashboardDrawerOpen = vi.fn()
    mocks.state = {
      ...mocks.state,
      agentDashboardDrawerOpen: true,
      setAgentDashboardDrawerOpen
    }

    render(sidebarElement())

    await waitFor(() => expect(setAgentDashboardDrawerOpen).toHaveBeenCalledWith(false))
  })

  it('detaches the project-drop owner while the sidebar is collapsed', () => {
    setSidebarState(getDefaultSettings(tmpdir()))
    const view = render(sidebarElement())
    expect(mocks.dropOwnerRef).toHaveBeenLastCalledWith(expect.any(HTMLDivElement))

    mocks.state = { ...mocks.state, sidebarOpen: false }
    view.rerender(sidebarElement())
    expect(mocks.dropOwnerRef).toHaveBeenLastCalledWith(null)
  })
})
