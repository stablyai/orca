// @vitest-environment happy-dom

import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import RightSidebar from './index'
import type { RightSidebarLayoutMode } from '../../../../shared/types'

const mockAppState = vi.hoisted(() => ({
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mockAppState.state)
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => null,
  getRepoMapFromState: () => new Map(),
  getWorktreeMapFromState: () => new Map()
}))

vi.mock('@/hooks/useSidebarResize', () => ({
  useSidebarResize: () => ({
    containerRef: { current: null },
    isResizing: false,
    onResizeStart: vi.fn()
  })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'F6'
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'darwin'
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => false,
  shouldRenderDesktopWindowChrome: () => false
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {})
    }
    return <span>{children}</span>
  }
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) => {
    if (asChild && isValidElement(children)) {
      return cloneElement(children as ReactElement<Record<string, unknown>>, {})
    }
    return <span>{children}</span>
  },
  ContextMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuRadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuRadioItem: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./right-sidebar-panel-content', () => ({
  RightSidebarPanelContent: () => <div data-panel-content />
}))

function renderSidebar(options: { layoutMode?: RightSidebarLayoutMode; open?: boolean }): string {
  mockAppState.state = {
    rightSidebarOpen: options.open ?? true,
    rightSidebarWidth: 350,
    setRightSidebarWidth: vi.fn(),
    rightSidebarTab: 'explorer',
    rightSidebarRouteRequestId: 0,
    setRightSidebarTab: vi.fn(),
    showRightSidebarFiles: vi.fn(),
    toggleRightSidebar: vi.fn(),
    activeWorktreeId: null,
    getKnownWorktreeById: () => null,
    activityBarPosition: 'top',
    setActivityBarPosition: vi.fn(),
    settings: options.layoutMode ? { rightSidebarLayoutMode: options.layoutMode } : null
  }
  return renderToStaticMarkup(<RightSidebar />)
}

function rootOpeningTag(markup: string): string {
  const match = markup.match(/^<div[^>]*>/)
  if (!match) {
    throw new Error(`root div opening tag not found in ${markup}`)
  }
  return match[0]
}

describe('right sidebar layout mode', () => {
  it('stays in the flex row by default (push)', () => {
    const root = rootOpeningTag(renderSidebar({}))
    expect(root).toContain('relative')
    expect(root).toContain('flex-shrink-0')
    expect(root).not.toContain('absolute')
  })

  it('keeps push layout when the setting is explicitly push', () => {
    const root = rootOpeningTag(renderSidebar({ layoutMode: 'push' }))
    expect(root).toContain('flex-shrink-0')
    expect(root).not.toContain('absolute')
  })

  it('floats over the workspace in overlay mode', () => {
    const root = rootOpeningTag(renderSidebar({ layoutMode: 'overlay' }))
    expect(root).toContain('absolute')
    expect(root).toContain('inset-y-0')
    expect(root).toContain('right-0')
    expect(root).toContain('z-30')
    expect(root).not.toContain('flex-shrink-0')
    expect(root).not.toContain('relative')
  })

  it('keeps the closed-state overflow clamp in overlay mode', () => {
    const root = rootOpeningTag(renderSidebar({ layoutMode: 'overlay', open: false }))
    expect(root).toContain('overflow-hidden')
    expect(root).toContain('absolute')
  })
})
