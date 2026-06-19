// @vitest-environment happy-dom

import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RightSidebar from './index'
import { TopActivityOverflowMenu } from './activity-bar-buttons'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'

const mockAppState = vi.hoisted(() => ({
  rightSidebarOpen: true,
  rightSidebarTab: 'explorer' as ActiveRightSidebarTab,
  rightSidebarRouteRequestId: 0,
  setRightSidebarTab: vi.fn(),
  showRightSidebarFiles: vi.fn(),
  activityBarPosition: 'top' as 'top' | 'side',
  activeWorktreeId: 'worktree-1',
  activeRepo: { id: 'repo-1', kind: 'git', connectionId: null } as {
    id: string
    kind: 'git' | 'folder'
    connectionId: string | null
  } | null,
  listeners: new Set<() => void>(),
  snapshotCache: new Map<(state: Record<string, unknown>) => unknown, unknown>(),
  cachedWorktree: null as { id: string; repoId: string } | null
}))

function notifyAppStore(): void {
  mockAppState.snapshotCache.clear()
  for (const listener of mockAppState.listeners) {
    listener()
  }
}

function getMockKnownWorktree(): { id: string; repoId: string } {
  if (mockAppState.cachedWorktree?.id !== mockAppState.activeWorktreeId) {
    mockAppState.cachedWorktree = {
      id: mockAppState.activeWorktreeId,
      repoId: 'repo-1'
    }
  }
  return mockAppState.cachedWorktree
}

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

vi.mock('@/store', async () => {
  const React = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const getSnapshot = (selector: (state: Record<string, unknown>) => unknown): unknown => {
    if (mockAppState.snapshotCache.has(selector)) {
      return mockAppState.snapshotCache.get(selector)
    }
    const selected = selector({
      rightSidebarOpen: mockAppState.rightSidebarOpen,
      rightSidebarWidth: 350,
      setRightSidebarWidth: vi.fn(),
      rightSidebarTab: mockAppState.rightSidebarTab,
      rightSidebarExplorerView: 'files',
      rightSidebarRouteRequestId: mockAppState.rightSidebarRouteRequestId,
      setRightSidebarTab: mockAppState.setRightSidebarTab,
      showRightSidebarFiles: mockAppState.showRightSidebarFiles,
      toggleRightSidebar: vi.fn(),
      activeWorktreeId: mockAppState.activeWorktreeId,
      getKnownWorktreeById: getMockKnownWorktree,
      activityBarPosition: mockAppState.activityBarPosition,
      setActivityBarPosition: vi.fn(),
      checksByWorktreeId: {},
      keybindings: {}
    })
    mockAppState.snapshotCache.set(selector, selected)
    return selected
  }

  return {
    useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
      React.useSyncExternalStore(
        (listener) => {
          mockAppState.listeners.add(listener)
          return () => {
            mockAppState.listeners.delete(listener)
          }
        },
        () => getSnapshot(selector),
        () => getSnapshot(selector)
      )
  }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => ({ id: 'worktree-1', repoId: 'repo-1' }),
  useRepoById: () => mockAppState.activeRepo,
  getWorktreeMapFromState: () => new Map()
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

vi.mock('./FolderWorkspaceWorktreesPanel', () => ({
  default: () => <div data-folder-workspace-worktrees-panel />
}))

vi.mock('./FolderWorkspacePrChecksPanel', () => ({
  default: () => <div data-folder-workspace-pr-checks-panel />
}))

vi.mock('./SourceControl', () => ({
  default: () => <div data-source-control />
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
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mockAppState.rightSidebarOpen = true
    mockAppState.rightSidebarTab = 'explorer'
    mockAppState.setRightSidebarTab = vi.fn((tab: ActiveRightSidebarTab) => {
      mockAppState.rightSidebarTab = tab
      mockAppState.rightSidebarRouteRequestId += 1
      notifyAppStore()
    })
    mockAppState.showRightSidebarFiles = vi.fn(() => {
      mockAppState.rightSidebarTab = 'explorer'
      mockAppState.rightSidebarRouteRequestId += 1
      notifyAppStore()
    })
    mockAppState.activityBarPosition = 'top'
    mockAppState.activeWorktreeId = 'worktree-1'
    mockAppState.activeRepo = { id: 'repo-1', kind: 'git', connectionId: null }
    mockAppState.rightSidebarRouteRequestId = 0
    mockAppState.listeners.clear()
    mockAppState.snapshotCache.clear()
    mockAppState.cachedWorktree = null
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
    expectNoDrag(buttonOpeningTag(markup, 'Source Control'))
    expectNoDrag(buttonOpeningTag(markup, 'Checks'))
    expect(buttonOpeningTag(markup, 'Toggle right sidebar')).toContain('sidebar-toggle')
  })

  it('hides git-only activity buttons for folder workspace ids without a backing repo', () => {
    mockAppState.activeWorktreeId = 'folder:folder-1'
    mockAppState.activeRepo = null

    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).toContain('aria-label="Explorer')
    expect(markup).toContain('aria-label="Agents')
    expect(markup).not.toContain('aria-label="Search')
    expect(markup).toContain('aria-label="Attached worktrees')
    expect(markup).toContain('aria-label="PR Checks')
    expect(markup).not.toContain('aria-label="Source Control')
    expect(markup).not.toContain('aria-label="Checks')
  })

  it('renders a visible fallback without overwriting a hidden folder-only tab', () => {
    mockAppState.rightSidebarTab = 'workspaces'
    mockAppState.activeWorktreeId = 'worktree-1'
    mockAppState.activeRepo = { id: 'repo-1', kind: 'git', connectionId: null }

    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).toContain('data-file-explorer')
    expect(markup).not.toContain('data-folder-workspace-worktrees-panel')
    expect(mockAppState.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('renders a visible fallback without overwriting a hidden PR Checks tab', () => {
    mockAppState.rightSidebarTab = 'pr-checks'
    mockAppState.activeWorktreeId = 'worktree-1'
    mockAppState.activeRepo = { id: 'repo-1', kind: 'git', connectionId: null }

    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).toContain('data-file-explorer')
    expect(markup).not.toContain('data-folder-workspace-pr-checks-panel')
    expect(mockAppState.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('keeps remembered folder PR Checks visible when the global route falls back to Explorer', async () => {
    mockAppState.activeWorktreeId = 'folder:folder-1'
    mockAppState.activeRepo = null
    const container = document.createElement('div')
    const root: Root = createRoot(container)

    await act(async () => {
      root.render(<RightSidebar />)
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label^="PR Checks"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.innerHTML).toContain('data-folder-workspace-pr-checks-panel')

    await act(async () => {
      mockAppState.rightSidebarTab = 'explorer'
      notifyAppStore()
    })

    expect(container.innerHTML).toContain('data-folder-workspace-pr-checks-panel')
    expect(container.innerHTML).not.toContain('data-file-explorer')

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label^="Explorer"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.innerHTML).toContain('data-file-explorer')

    await act(async () => {
      mockAppState.rightSidebarTab = 'pr-checks'
      notifyAppStore()
    })

    expect(container.innerHTML).toContain('data-file-explorer')
    expect(container.innerHTML).not.toContain('data-folder-workspace-pr-checks-panel')

    await act(async () => {
      root.unmount()
    })
  })

  it('does not render hidden panel content while the sidebar is closed', () => {
    mockAppState.rightSidebarOpen = false

    const markup = renderToStaticMarkup(<RightSidebar />)

    expect(markup).not.toContain('data-file-explorer')
    expect(markup).not.toContain('data-source-control')
    expect(markup).not.toContain('data-checks-panel')
    expect(markup).not.toContain('data-ports-panel')
  })
})
