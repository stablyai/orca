// @vitest-environment happy-dom

import type { CSSProperties, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { tmpdir } from 'node:os'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
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
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./SidebarHeader', () => ({
  default: () => <div data-testid="sidebar-header" />
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
    nativeDropTarget: undefined,
    dropHandlers: {},
    affordance: { visible: false }
  })
}))

vi.mock('./useWorkspaceBoardPanel', () => ({
  useWorkspaceBoardPanel: () => ({
    workspaceBoardOpen: false,
    workspaceBoardRenderedOpen: true,
    workspaceBoardDragPreviewOpen: false,
    workspaceBoardMenuOpen: false,
    toggleWorkspaceBoard: vi.fn(),
    handleWorkspaceBoardOpenChange: vi.fn(),
    setWorkspaceBoardMenuOpen: vi.fn(),
    closeWorkspaceBoard: vi.fn(),
    previewWorkspaceBoardFromDrag: vi.fn(),
    solidifyWorkspaceBoardFromDrag: vi.fn(),
    cancelWorkspaceBoardDragPreview: vi.fn()
  })
}))

import Sidebar from './index'

function setSidebarState(settings: GlobalSettings, statusBarVisible = true): void {
  mocks.state = {
    activeModal: null,
    fetchAllWorktrees: vi.fn(),
    repos: [],
    setSidebarWidth: vi.fn(),
    settings,
    sidebarOpen: true,
    sidebarWidth: 320,
    statusBarVisible
  }
}

function renderSidebar(): string {
  return renderToStaticMarkup(
    <Sidebar worktreeScrollOffsetRef={{ current: 0 }} worktreeScrollAnchorRef={{ current: null }} />
  )
}

function sidebarElement(): ReactNode {
  return (
    <Sidebar worktreeScrollOffsetRef={{ current: 0 }} worktreeScrollAnchorRef={{ current: null }} />
  )
}

afterEach(cleanup)

describe('Sidebar', () => {
  it('applies left sidebar appearance variables to the workspace sidebar surface', () => {
    setSidebarState({
      ...getDefaultSettings(tmpdir()),
      leftSidebarAppearanceMode: 'match-terminal',
      terminalColorOverrides: {
        background: '#101820',
        foreground: '#f0f4f8'
      }
    })

    const markup = renderSidebar()

    expect(markup).toContain('--worktree-sidebar:#101820')
    expect(markup).toContain('--worktree-sidebar-foreground:#f0f4f8')
    expect(markup).toContain('data-testid="workspace-kanban-drawer"')
    expect(markup.match(/--worktree-sidebar:#101820/g)).toHaveLength(2)
  })

  it('passes status bar visibility into the workspace board drawer', () => {
    setSidebarState(getDefaultSettings(tmpdir()), false)

    const markup = renderSidebar()

    expect(markup).toContain('data-testid="workspace-kanban-drawer"')
    expect(markup).toContain('data-status-bar-visible="false"')
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

  it('does not scan when runtime hosts come online during the startup refresh', async () => {
    setSidebarState(getDefaultSettings(tmpdir()))
    const fetchAllWorktrees = vi.fn().mockResolvedValue(undefined)
    mocks.state = {
      ...mocks.state,
      fetchAllWorktrees,
      fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
      runtimeStatusByEnvironmentId: new Map(),
      startupWorktreeRefreshCompleted: false
    }
    const view = render(sidebarElement())

    mocks.state = {
      ...mocks.state,
      runtimeStatusByEnvironmentId: new Map([['runtime-a', { status: 'connected' }]])
    }
    view.rerender(sidebarElement())
    expect(fetchAllWorktrees).not.toHaveBeenCalled()

    mocks.state = { ...mocks.state, startupWorktreeRefreshCompleted: true }
    view.rerender(sidebarElement())
    expect(fetchAllWorktrees).not.toHaveBeenCalled()

    mocks.state = {
      ...mocks.state,
      runtimeStatusByEnvironmentId: new Map([
        ['runtime-a', { status: 'connected' }],
        ['runtime-b', { status: 'connected' }]
      ])
    }
    view.rerender(sidebarElement())
    await waitFor(() => expect(fetchAllWorktrees).toHaveBeenCalledTimes(1))
  })
})
