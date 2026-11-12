// @vitest-environment happy-dom

import type { CSSProperties, ReactNode } from 'react'

import { tmpdir } from 'node:os'
import { act, cleanup, render } from '@testing-library/react'
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

vi.mock('./worktree-list/listing/WorktreeList', () => ({
  default: () => <div data-testid="worktree-list" />
}))

vi.mock('./WslMovedProjectsSection', () => ({ default: () => null }))
vi.mock('./hidden-projects/HiddenProjectsSection', () => ({ default: () => null }))
vi.mock('./hidden-projects/hidden-project-filter-pruning', () => ({
  followHiddenProjectFilters: () => () => {}
}))

vi.mock('./SidebarToolbar', () => ({
  default: () => <div data-testid="sidebar-toolbar" />
}))

vi.mock('./workspace-board/surface/WorkspaceKanbanDrawer', () => ({
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

vi.mock('./project-admission/drop/useSidebarProjectDrop', () => ({
  useSidebarProjectDrop: () => ({
    dropOwnerRef: mocks.dropOwnerRef,
    dropHandlers: {},
    affordance: { visible: false }
  })
}))

vi.mock('./workspace-board/surface/useWorkspaceBoardPanel', () => ({
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
  it('shows a compact loading status until startup discovery finishes', () => {
    vi.useFakeTimers()
    try {
      setSidebarState(getDefaultSettings(tmpdir()))
      mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: false }
      const view = render(sidebarElement())
      expect(view.queryByRole('status')).toBeNull()
      act(() => vi.advanceTimersByTime(200))
      expect(view.getByRole('status').textContent).toBe('Loading workspaces…')
      mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: true }
      view.rerender(sidebarElement())
      expect(view.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
