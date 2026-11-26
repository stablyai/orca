// @vitest-environment happy-dom

import type { CSSProperties, ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SidebarCollapseRail from './SidebarCollapseRail'

const mocks = vi.hoisted(
  (): {
    state: Record<string, unknown>
    closeWorkspaceBoard: ReturnType<typeof vi.fn>
    dropOwnerRef: ReturnType<typeof vi.fn>
    openWorkspaceCreationComposerWithTourHandoff: ReturnType<typeof vi.fn>
    panel: {
      workspaceBoardOpen: boolean
      workspaceBoardRenderedOpen: boolean
      workspaceBoardDragPreviewOpen: boolean
    }
  } => ({
    state: {},
    closeWorkspaceBoard: vi.fn(),
    dropOwnerRef: vi.fn(),
    openWorkspaceCreationComposerWithTourHandoff: vi.fn(),
    panel: {
      workspaceBoardOpen: false,
      workspaceBoardRenderedOpen: true,
      workspaceBoardDragPreviewOpen: false
    }
  })
)

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

vi.mock('./chrome/SidebarHeader', () => ({
  default: ({ onCollapseSidebar }: { onCollapseSidebar?: () => void }) => (
    <div data-testid="sidebar-header">
      {onCollapseSidebar ? (
        <button aria-label="Collapse sidebar" type="button" onClick={onCollapseSidebar} />
      ) : null}
    </div>
  )
}))

vi.mock('./chrome/SidebarNav', () => ({
  default: () => <div data-testid="sidebar-nav" />
}))

vi.mock('./setup-script-prompts/SetupScriptPromptCard', () => ({
  default: () => <div data-testid="setup-script-prompt-card" />
}))

vi.mock('./worktree-list/listing/WorktreeList', () => ({
  default: () => <div data-testid="worktree-list" />
}))

vi.mock('./chrome/SidebarToolbar', () => ({
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

vi.mock('../contextual-tours/workspace-creation-tour-handoff', () => ({
  openWorkspaceCreationComposerWithTourHandoff: mocks.openWorkspaceCreationComposerWithTourHandoff
}))

afterEach(cleanup)

describe('SidebarCollapseRail', () => {
  it('fires expand, new workspace, and settings from the rail buttons', () => {
    const onExpand = vi.fn()
    const onNewWorkspace = vi.fn()
    const onOpenSettings = vi.fn()
    const view = render(
      <SidebarCollapseRail
        onExpand={onExpand}
        onNewWorkspace={onNewWorkspace}
        onOpenSettings={onOpenSettings}
      />
    )

    expect(view.container.querySelector('[data-sidebar-collapse-rail]')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Expand sidebar' }))
    fireEvent.click(view.getByRole('button', { name: 'New workspace' }))
    fireEvent.click(view.getByRole('button', { name: 'Settings' }))

    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(onNewWorkspace).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('exposes toggle shortcuts on the rail expand and new workspace buttons', () => {
    const view = render(
      <SidebarCollapseRail onExpand={vi.fn()} onNewWorkspace={vi.fn()} onOpenSettings={vi.fn()} />
    )

    const expandShortcut = view
      .getByRole('button', { name: 'Expand sidebar' })
      .getAttribute('aria-keyshortcuts')
    const newWorkspaceShortcut = view
      .getByRole('button', { name: 'New workspace' })
      .getAttribute('aria-keyshortcuts')
    expect(expandShortcut).toBeTruthy()
    expect(newWorkspaceShortcut).toBeTruthy()
  })
})
