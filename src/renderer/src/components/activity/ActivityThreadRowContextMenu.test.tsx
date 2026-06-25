/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  ActivityThreadRowContextMenu,
  type ActivityThreadRowContextMenuProps
} from './ActivityThreadRowContextMenu'
import type { TerminalTab } from '../../../../shared/types'

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: {
    children?: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
  } & React.ComponentPropsWithoutRef<'button'>) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()} {...props}>
      {children}
    </button>
  ),
  ContextMenuLabel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuSubTrigger: ({
    children,
    disabled
  }: {
    children?: React.ReactNode
    disabled?: boolean
  }) => (
    <button type="button" disabled={disabled}>
      {children}
    </button>
  ),
  ContextMenuSubContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuRadioGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ContextMenuRadioItem: ({
    children,
    onSelect,
    ...props
  }: {
    children?: React.ReactNode
    onSelect?: () => void
  } & React.ComponentPropsWithoutRef<'button'>) => (
    <button type="button" onClick={() => onSelect?.()} {...props}>
      {children}
    </button>
  )
}))

vi.mock('../sidebar/workspace-status', () => ({
  getWorkspaceStatusVisualMeta: () => ({
    tone: 'text-muted-foreground',
    icon: () => null
  })
}))

const mockTab = {
  id: 'tab-1',
  ptyId: 'pty-1',
  worktreeId: 'wt-1',
  title: 'Agent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false
} as unknown as TerminalTab // Why: mock tab only exercises context menu fields

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderMenu(overrides: Partial<ActivityThreadRowContextMenuProps> = {}): {
  container: HTMLDivElement
  root: Root
  onCloseTab: Mock<(tabId: string) => void>
  onRenameOpen: Mock<() => void>
  onSetTabColor: Mock<(tabId: string, color: string | null) => void>
  onMarkRead: Mock<() => void>
  onMarkUnread: Mock<() => void>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const onCloseTab = vi.fn()
  const onRenameOpen = vi.fn()
  const onSetTabColor = vi.fn()
  const onMarkRead = vi.fn()
  const onMarkUnread = vi.fn()

  const defaultProps: ActivityThreadRowContextMenuProps = {
    children: <div>Row Child</div>,
    tab: mockTab,
    unread: false,
    liveTab: true,
    onCloseTab,
    onRenameOpen,
    onSetTabColor,
    onMarkRead,
    onMarkUnread
  }

  act(() => {
    root.render(<ActivityThreadRowContextMenu {...defaultProps} {...overrides} />)
  })

  mounted.push({ container, root })
  return {
    container,
    root,
    onCloseTab,
    onRenameOpen,
    onSetTabColor,
    onMarkRead,
    onMarkUnread
  }
}

function getButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((btn) =>
    btn.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`)
  }
  return button
}

afterEach(() => {
  while (mounted.length > 0) {
    const item = mounted.pop()
    if (item) {
      act(() => {
        item.root.unmount()
      })
      item.container.remove()
    }
  }
})

describe('ActivityThreadRowContextMenu', () => {
  it('calls onCloseTab when Close is clicked and tab is live and not pinned', () => {
    const { container, onCloseTab } = renderMenu()
    const btn = getButton(container, 'Close')
    expect(btn.disabled).toBe(false)
    act(() => {
      btn.click()
    })
    expect(onCloseTab).toHaveBeenCalledWith('tab-1')
  })

  it('disables Close when tab is pinned', () => {
    const { container } = renderMenu({
      tab: { ...mockTab, isPinned: true }
    })
    const btn = getButton(container, 'Close')
    expect(btn.disabled).toBe(true)
  })

  it('disables Close when tab is not live', () => {
    const { container } = renderMenu({ liveTab: false })
    const btn = getButton(container, 'Close')
    expect(btn.disabled).toBe(true)
  })

  it('calls onRenameOpen when Change Title is clicked and live', () => {
    const { container, onRenameOpen } = renderMenu()
    const btn = getButton(container, 'Change Title')
    expect(btn.disabled).toBe(false)
    act(() => {
      btn.click()
    })
    expect(onRenameOpen).toHaveBeenCalled()
  })

  it('disables Change Title when tab is not live', () => {
    const { container } = renderMenu({ liveTab: false })
    const btn = getButton(container, 'Change Title')
    expect(btn.disabled).toBe(true)
  })

  it('calls onSetTabColor when a color is clicked', () => {
    const { container, onSetTabColor } = renderMenu()
    const swatches = Array.from(container.querySelectorAll('button')).filter(
      (btn) => btn.getAttribute('aria-label') !== null
    )
    expect(swatches.length).toBeGreaterThan(0)
    const orangeSwatch = swatches.find((btn) => btn.getAttribute('aria-label')?.includes('Orange'))
    if (!orangeSwatch) {
      throw new Error('Orange swatch not found')
    }
    act(() => {
      orangeSwatch.click()
    })
    expect(onSetTabColor).toHaveBeenCalledWith('tab-1', '#f97316')
  })

  it('calls onMarkRead when unread and Mark Read is clicked', () => {
    const { container, onMarkRead } = renderMenu({ unread: true })
    const btn = getButton(container, 'Mark Read')
    act(() => {
      btn.click()
    })
    expect(onMarkRead).toHaveBeenCalled()
  })

  it('calls onMarkUnread when read and Mark Unread is clicked', () => {
    const { container, onMarkUnread } = renderMenu({ unread: false })
    const btn = getButton(container, 'Mark Unread')
    act(() => {
      btn.click()
    })
    expect(onMarkUnread).toHaveBeenCalled()
  })
})
