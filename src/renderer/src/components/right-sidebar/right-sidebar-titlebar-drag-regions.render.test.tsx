import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RightSidebar from './index'
import { TopActivityOverflowMenu } from './activity-bar-buttons'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'

const mockAppState = vi.hoisted(() => ({
  activityBarPosition: 'top' as 'top' | 'side'
}))

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
      activityBarPosition: mockAppState.activityBarPosition,
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

function buttonOpeningTag(markup: string, ariaLabelPrefix: string): string {
  const escapedPrefix = ariaLabelPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = markup.match(new RegExp(`<button[^>]+aria-label="${escapedPrefix}[^"]*"[^>]*>`))
  if (!match) {
    throw new Error(`button with aria-label prefix "${ariaLabelPrefix}" not found in ${markup}`)
  }
  return match[0]
}

function expectNoDrag(tag: string): void {
  expect(tag).toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
}

describe('rendered right sidebar titlebar drag regions', () => {
  beforeEach(() => {
    mockAppState.activityBarPosition = 'top'
  })

  it('keeps the rendered top activity strip draggable, context-menuable, and only controls no-drag', () => {
    const markup = renderToStaticMarkup(<RightSidebar />)
    const header = openingTag(markup, 'right-sidebar-header-drag')
    const activityStrip = openingTag(markup, 'right-sidebar-activity-strip')

    expect(header).not.toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
    expect(activityStrip).not.toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
    expect(activityStrip).toContain('data-context-menu-trigger="true"')
    expect(markup).toContain('right-sidebar-header-drag')

    expectNoDrag(buttonOpeningTag(markup, 'Explorer'))
    expectNoDrag(buttonOpeningTag(markup, 'Search'))
    expectNoDrag(buttonOpeningTag(markup, 'Source Control'))
    expectNoDrag(buttonOpeningTag(markup, 'Checks'))
    expect(buttonOpeningTag(markup, 'Toggle right sidebar')).toContain('sidebar-toggle')
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

  it('keeps side activity-bar controls no-drag without cancelling the side header drag region', () => {
    mockAppState.activityBarPosition = 'side'

    const markup = renderToStaticMarkup(<RightSidebar />)
    const sideHeader = openingTag(markup, 'right-sidebar-header-drag')
    const sideStrip = openingTag(markup, 'side-activity-bar-windows-inset')

    expect(sideHeader).not.toContain(RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME)
    expect(sideHeader).toContain('right-sidebar-header-side-inset')
    expect(sideStrip).toContain('data-context-menu-trigger="true"')

    expectNoDrag(buttonOpeningTag(markup, 'Explorer'))
    expectNoDrag(buttonOpeningTag(markup, 'Search'))
    expectNoDrag(buttonOpeningTag(markup, 'Source Control'))
    expectNoDrag(buttonOpeningTag(markup, 'Checks'))
    expect(buttonOpeningTag(markup, 'Toggle right sidebar')).toContain('sidebar-toggle')
  })
})
