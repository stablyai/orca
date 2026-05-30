import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import RightSidebar from './index'
import { TopActivityOverflowMenu } from './activity-bar-buttons'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'

vi.mock('@/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({
    containerRef: { current: null },
    isResizing: false,
    onResizeStart: vi.fn()
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: (actionId: string) => actionId
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      rightSidebarOpen: true,
      rightSidebarWidth: 350,
      setRightSidebarWidth: vi.fn(),
      rightSidebarTab: 'explorer',
      setRightSidebarTab: vi.fn(),
      toggleRightSidebar: vi.fn(),
      activityBarPosition: 'top',
      setActivityBarPosition: vi.fn(),
      checksByWorktreeId: {},
      keybindings: {}
    })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'worktree-1', repoId: 'repo-1' }),
  useRepoById: () => ({ id: 'repo-1', kind: 'git', connectionId: null })
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-tooltip-trigger': 'true'
      })
    }
    return <span data-tooltip-trigger>{children}</span>
  }
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-context-menu-trigger': 'true'
      })
    }
    return <span data-context-menu-trigger>{children}</span>
  },
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuRadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuRadioItem: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        'data-dropdown-trigger': 'true'
      })
    }
    return <span data-dropdown-trigger>{children}</span>
  }
}))

vi.mock('./FileExplorer', () => ({
  default: () => <div data-file-explorer />
}))

vi.mock('./SourceControl', () => ({
  default: () => <div data-source-control />
}))

vi.mock('./Search', () => ({
  default: () => <div data-search-panel />
}))

vi.mock('./ChecksPanel', () => ({
  default: () => <div data-checks-panel />
}))

vi.mock('./PortsPanel', () => ({
  default: () => <div data-ports-panel />
}))

function openingTag(markup: string, className: string): string {
  const match = markup.match(new RegExp(`<[^>]+class="[^"]*${className}[^"]*"[^>]*>`))
  if (!match) {
    throw new Error(`opening tag with class "${className}" not found in ${markup}`)
  }
  return match[0]
}

describe('rendered right sidebar titlebar drag regions', () => {
  it('keeps the rendered top activity strip draggable and only controls no-drag', () => {
    const markup = renderToStaticMarkup(<RightSidebar />)
    const activityStrip = openingTag(markup, 'right-sidebar-activity-strip')

    expect(activityStrip).not.toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
    expect(markup).toContain('right-sidebar-header-drag')
    expect(markup).toContain(`class="sidebar-toggle mr-1"`)
    expect(markup).toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
  })

  it('keeps the overflow trigger no-drag when it renders', () => {
    const markup = renderToStaticMarkup(
      <TopActivityOverflowMenu
        items={[
          {
            id: 'checks',
            icon: () => <span data-checks-icon />,
            title: 'Checks',
            shortcut: 'shortcut'
          }
        ]}
        activeTab="explorer"
        onSelect={vi.fn()}
      />
    )

    const overflowButton = openingTag(markup, RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
    expect(overflowButton).toContain('aria-label="More sidebar tabs"')
  })
})
