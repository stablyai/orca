import type { CSSProperties, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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

describe('Sidebar', () => {
  it('applies left sidebar appearance variables to the workspace sidebar surface', () => {
    setSidebarState({
      ...getDefaultSettings('/tmp'),
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
    setSidebarState(getDefaultSettings('/tmp'), false)

    const markup = renderSidebar()

    expect(markup).toContain('data-testid="workspace-kanban-drawer"')
    expect(markup).toContain('data-status-bar-visible="false"')
  })
})
