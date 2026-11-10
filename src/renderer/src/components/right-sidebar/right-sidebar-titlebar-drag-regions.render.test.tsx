// @vitest-environment happy-dom

import type * as ReactModule from 'react'
import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RightSidebar from './index'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome-types'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'

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
  cachedWorktree: null as { id: string; repoId: string } | null,
  vaultLoad: { promise: Promise.resolve(), pending: false }
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

vi.mock('@/store/index', async () => {
  const React = await vi.importActual<typeof ReactModule>('react')
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
      setRightSidebarEffectiveTab: vi.fn(),
      toggleRightSidebar: vi.fn(),
      activeWorktreeId: mockAppState.activeWorktreeId,
      getKnownWorktreeById: getMockKnownWorktree,
      activityBarPosition: mockAppState.activityBarPosition,
      setActivityBarPosition: vi.fn(),
      checksByWorktreeId: {},
      keybindings: {},
      activeView: 'terminal',
      activePendingCreationId: null,
      pendingWorktreeCreations: {}
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

vi.mock('@/store/workspaces/selection/use-selected-worktree', () => ({
  useActiveWorktree: () => ({ id: 'worktree-1', repoId: 'repo-1' })
}))
vi.mock('@/store/repos/use-repository-catalog', () => ({
  useRepoById: () => mockAppState.activeRepo
}))
vi.mock('@/store/slices/worktrees/listing/worktree-catalog-index', () => ({
  getIndexedWorktreeMap: () => new Map()
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

vi.mock('./file-explorer/panel/FileExplorer', () => ({
  default: () => <div data-file-explorer />
}))

vi.mock('./FolderWorkspaceWorktreesPanel', () => ({
  default: () => <div data-folder-workspace-worktrees-panel />
}))

vi.mock('./hosted-review/folder-checks/FolderWorkspacePrChecksPanel', () => ({
  default: () => <div data-folder-workspace-pr-checks-panel />
}))

vi.mock('./source-control/panel/SourceControl', () => ({
  default: () => <div data-source-control />
}))

vi.mock('./checks-panel/ChecksPanel', () => ({
  default: () => <div data-checks-panel />
}))

vi.mock('./PortsPanel', () => ({
  default: () => <div data-ports-panel />
}))

vi.mock('./ai-vault/panel/AiVaultSidebarPanel', async () => {
  const React = await vi.importActual<typeof ReactModule>('react')
  return {
    default: function MockAiVaultSidebarPanel({
      focusSearch,
      onFocusSearchHandled
    }: {
      focusSearch: boolean
      onFocusSearchHandled: () => void
    }) {
      if (mockAppState.vaultLoad.pending) {
        throw mockAppState.vaultLoad.promise
      }
      const inputRef = React.useRef<HTMLInputElement>(null)
      React.useEffect(() => {
        if (focusSearch) {
          inputRef.current?.focus()
          onFocusSearchHandled()
        }
      }, [focusSearch, onFocusSearchHandled])
      return <input ref={inputRef} aria-label="Search sessions" />
    }
  }
})

function setRendererPlatform(platform: NodeJS.Platform): void {
  resetRendererAppPlatformCacheForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: {
        get: () => ({ platform, osRelease: '' })
      }
    }
  })
}

describe('right sidebar panel routing', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = false
    setRendererPlatform('darwin')
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
    mockAppState.vaultLoad.pending = false
  })

  it('focuses session search on an explicit switch but not when restoring the tab', async () => {
    mockAppState.rightSidebarTab = 'vault'
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await import('./ai-vault/panel/AiVaultSidebarPanel')
      await act(async () => root.render(<RightSidebar />))
      expect(container.querySelector('[aria-label="Search sessions"]')).not.toBeNull()
      expect(document.activeElement).not.toBe(
        container.querySelector('[aria-label="Search sessions"]')
      )

      await act(async () => mockAppState.setRightSidebarTab('explorer'))
      await act(async () => mockAppState.setRightSidebarTab('vault'))
      expect(document.activeElement).toBe(container.querySelector('[aria-label="Search sessions"]'))
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('does not move focus after the user types while session search is loading', async () => {
    let finishLoad = (): void => {}
    mockAppState.vaultLoad.pending = true
    mockAppState.vaultLoad.promise = new Promise<void>((resolve) => {
      finishLoad = resolve
    })
    const container = document.createElement('div')
    const otherInput = document.createElement('input')
    document.body.append(otherInput, container)
    const root = createRoot(container)
    try {
      await import('./ai-vault/panel/AiVaultSidebarPanel')
      await act(async () => root.render(<RightSidebar />))
      otherInput.focus()
      await act(async () => mockAppState.setRightSidebarTab('vault'))
      await act(async () =>
        otherInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
      )
      await act(async () => {
        mockAppState.vaultLoad.pending = false
        finishLoad()
      })
      expect(container.querySelector('[aria-label="Search sessions"]')).not.toBeNull()
      expect(document.activeElement).toBe(otherInput)
    } finally {
      mockAppState.vaultLoad.pending = false
      finishLoad()
      await act(async () => root.unmount())
      container.remove()
      otherInput.remove()
    }
  })

  it('renders a visible fallback without overwriting a hidden folder-only tab', async () => {
    mockAppState.rightSidebarTab = 'workspaces'
    mockAppState.activeWorktreeId = 'worktree-1'
    mockAppState.activeRepo = { id: 'repo-1', kind: 'git', connectionId: null }

    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<RightSidebar />)
      })
      expect(container.innerHTML).toContain('data-file-explorer')
      expect(container.innerHTML).not.toContain('data-folder-workspace-worktrees-panel')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('renders a visible fallback without overwriting a hidden PR Checks tab', async () => {
    mockAppState.rightSidebarTab = 'pr-checks'
    mockAppState.activeWorktreeId = 'worktree-1'
    mockAppState.activeRepo = { id: 'repo-1', kind: 'git', connectionId: null }

    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(<RightSidebar />)
      })
      expect(container.innerHTML).toContain('data-file-explorer')
      expect(container.innerHTML).not.toContain('data-folder-workspace-pr-checks-panel')
    } finally {
      await act(async () => root.unmount())
    }
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
