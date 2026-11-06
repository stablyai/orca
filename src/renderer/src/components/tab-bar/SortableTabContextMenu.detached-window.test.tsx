/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const storeMock = vi.hoisted((): { state: Record<string, unknown> } => ({ state: {} }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  formatShortcutLabel: () => '⌘D',
  useOptionalShortcutLabel: () => '⌘D'
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => children,
  ContextMenuContent: ({ children }: { children?: ReactNode }) => children,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  ContextMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children?: ReactNode }) => children,
  ContextMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  ContextMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  ContextMenuShortcut: ({ children }: { children?: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./use-allow-auto-close', () => ({ useAllowAutoClose: () => undefined }))

vi.mock('./TabSessionSurfaceSwitchMenuItems', () => ({
  TabSessionSurfaceSwitchMenuItems: () => null
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeMock.state),
    { getState: () => storeMock.state }
  )
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderMenu(
  overrides: Partial<ComponentProps<typeof SortableTabContextMenu>> = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <SortableTabContextMenu
        open
        tab={{ id: 'term-1', worktreeId: 'wt-1', color: null }}
        unifiedTabId="tab-1"
        groupId="group-1"
        isActive
        tabCount={2}
        hasTabsToRight
        hasTabsToLeft
        isPinned={false}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onCloseToLeft={vi.fn()}
        onRenameOpen={vi.fn()}
        onSetTabColor={vi.fn()}
        onTogglePin={vi.fn()}
        {...overrides}
      />
    )
  })
  mounted.push({ container, root })
  return container
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`)
  }
  return button
}

beforeEach(() => {
  storeMock.state = {
    keybindings: {},
    groupsByWorktree: {
      'wt-1': [
        { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-2'] }
      ]
    },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'terminal',
          entityId: 'term-1',
          label: 'bash',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  }
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('SortableTabContextMenu move to new window', () => {
  it('shows the terminal-only move action and invokes it', () => {
    const onMove = vi.fn()
    const container = renderMenu({
      detachedWindow: { isDetached: false, onMove, disabled: false, localOnly: false }
    })

    act(() => getButton(container, 'Move to New Window').click())

    expect(onMove).toHaveBeenCalledOnce()
  })

  it('names the action Show Window once the tab is in its own window', () => {
    const onMove = vi.fn()
    const container = renderMenu({
      detachedWindow: { isDetached: true, onMove, disabled: false, localOnly: false }
    })

    expect(container.textContent).not.toContain('Move to New Window')
    act(() => getButton(container, 'Show Window').click())

    expect(onMove).toHaveBeenCalledOnce()
  })

  it('omits the move action when the caller is not a terminal tab', () => {
    const container = renderMenu()

    expect(container.textContent).not.toContain('Move to New Window')
  })

  it('disables unsupported remote terminals with the Local only hint', () => {
    const container = renderMenu({
      detachedWindow: { isDetached: false, onMove: vi.fn(), disabled: true, localOnly: true }
    })

    expect(getButton(container, 'Move to New Window').disabled).toBe(true)
    expect(container.textContent).toContain('Local only')
  })

  it('disables move to new window for split terminals without Local only hint', () => {
    const container = renderMenu({
      detachedWindow: { isDetached: false, onMove: vi.fn(), disabled: true, localOnly: false }
    })

    expect(getButton(container, 'Move to New Window').disabled).toBe(true)
    expect(container.textContent).not.toContain('Local only')
  })
})
