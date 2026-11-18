/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const storeMock = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    keybindings: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {}
  }
  return { state }
})

vi.mock('@/lib/keyboard/useShortcutLabel', () => ({
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

vi.mock('lucide-react', () => ({
  ArrowDown: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  Columns2: () => null,
  Copy: () => null,
  ListX: () => null,
  MessageSquare: () => null,
  PanelBottomClose: () => null,
  PanelLeftClose: () => null,
  PanelRightClose: () => null,
  Pencil: () => null,
  Pin: () => null,
  PinOff: () => null,
  SquareTerminal: () => null,
  X: () => null
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('./use-allow-auto-close', () => ({ useAllowAutoClose: () => undefined }))

vi.mock('../session-actions/TabSessionSurfaceSwitchMenuItems', () => ({
  TabSessionSurfaceSwitchMenuItems: ({
    tab,
    nativeChat,
    leadingSeparator
  }: {
    tab: { id: string }
    nativeChat?: { sessionId: string }
    leadingSeparator: boolean
  }) => (
    <div
      data-testid="session-surface-switch"
      data-tab-id={tab.id}
      data-structured-session-id={nativeChat?.sessionId ?? ''}
      data-leading-separator={String(leadingSeparator)}
    />
  )
}))

// The menu's move goes where the tab bar's does; that move's own path is pinned in
// tab-move-to-pane-column.test.ts and, through main's frame, tab-moves-drawn-from-frames.test.ts.
const moveMock = vi.hoisted(() => ({ moveTabToNewPaneColumn: vi.fn(() => true) }))
vi.mock('../pane-actions/tab-move-to-pane-column', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  moveTabToNewPaneColumn: moveMock.moveTabToNewPaneColumn
}))

vi.mock('../../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeMock.state),
    {
      getState: () => storeMock.state
    }
  )
}))

const mounted: { container: HTMLDivElement; root: Root }[] = []

function renderMenu(overrides: Partial<ComponentProps<typeof SortableTabContextMenu>> = {}): {
  container: HTMLDivElement
  root: Root
  onActivate: ReturnType<typeof vi.fn>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onActivate = vi.fn()
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
        onActivate={onActivate}
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
  return { container, root, onActivate }
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
  moveMock.moveTabToNewPaneColumn.mockClear()
  storeMock.state = {
    keybindings: {},
    groupsByWorktree: {
      'wt-1': [
        {
          id: 'group-1',
          worktreeId: 'wt-1',
          activeTabId: 'tab-1',
          tabOrder: ['tab-1', 'tab-2']
        }
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

describe('SortableTabContextMenu', () => {
  it('offers neither Close, Pin Tab nor Change Title on a tab that stays open', () => {
    const onClose = vi.fn()
    const { container } = renderMenu({ closable: false, onClose })

    const close = getButton(container, 'Close')
    expect(close.disabled).toBe(true)
    act(() => close.click())
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Pin Tab')
    expect(container.textContent).not.toContain('Change Title')
    expect(container.querySelector('[data-testid="session-surface-switch"]')).toBeNull()
  })

  it("keeps a bot's chat tab out of the terminal", () => {
    const { container } = renderMenu({ canContinueInTerminal: false })

    expect(container.textContent).toContain('Pin Tab')
    expect(container.querySelector('[data-testid="session-surface-switch"]')).toBeNull()
  })
})
