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

// Stub the heavy sidebar children so the test exercises only the root surface.
vi.mock('./SidebarHeader', () => ({ default: () => null }))
vi.mock('./SidebarNav', () => ({ default: () => null }))
vi.mock('./SetupScriptPromptCard', () => ({ default: () => null }))
vi.mock('./WorktreeList', () => ({ default: () => null }))
vi.mock('./SidebarToolbar', () => ({ default: () => null }))
vi.mock('./WorkspaceKanbanDrawer', () => ({ default: () => null }))

vi.mock('@/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({ containerRef: { current: null }, onResizeStart: vi.fn() })
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
    workspaceBoardMenuOpen: false,
    toggleWorkspaceBoard: vi.fn(),
    handleWorkspaceBoardOpenChange: vi.fn(),
    setWorkspaceBoardMenuOpen: vi.fn(),
    closeWorkspaceBoard: vi.fn()
  })
}))

vi.mock('@/components/terminal-pane/use-system-prefers-dark', () => ({
  useSystemPrefersDark: () => true
}))

import Sidebar from './index'

function renderSidebar(settings: GlobalSettings): string {
  mocks.state = {
    sidebarOpen: true,
    sidebarWidth: 260,
    setSidebarWidth: vi.fn(),
    settings,
    repos: [],
    fetchAllWorktrees: vi.fn(),
    activeModal: null
  }
  return renderToStaticMarkup(
    <Sidebar worktreeScrollOffsetRef={{ current: 0 }} worktreeScrollAnchorRef={{ current: null }} />
  )
}

describe('Sidebar appearance', () => {
  it('applies the resolved appearance variables to the workspace sidebar root', () => {
    const markup = renderSidebar({
      ...getDefaultSettings('/tmp'),
      leftSidebarAppearanceMode: 'match-terminal',
      terminalColorOverrides: {
        background: '#101820',
        foreground: '#f0f4f8'
      }
    })

    expect(markup).toContain('--worktree-sidebar:#101820')
    expect(markup).toContain('--worktree-sidebar-foreground:#f0f4f8')
  })

  it('leaves the root unstyled in default appearance mode so global tokens apply', () => {
    const markup = renderSidebar({
      ...getDefaultSettings('/tmp'),
      leftSidebarAppearanceMode: 'default'
    })

    expect(markup).not.toContain('--worktree-sidebar:')
  })
})
