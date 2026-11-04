/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT } from '@/constants/terminal'
import { requestActiveTerminalPaneSplit } from './request-active-terminal-pane-split'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const storeMock = vi.hoisted(() => ({
  state: {
    keybindings: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {}
  } as Record<string, unknown>
}))

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

vi.mock('./TabSessionSurfaceSwitchMenuItems', () => ({
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
vi.mock('./tab-move-to-pane-column', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  moveTabToNewPaneColumn: moveMock.moveTabToNewPaneColumn
}))

vi.mock('../../store', () => ({
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

function getSurfaceSwitchMarker(container: HTMLElement): Element {
  const marker = container.querySelector('[data-testid="session-surface-switch"]')
  if (!marker) {
    throw new Error('Missing session surface switch items')
  }
  return marker
}

function getLastSplitEvent(spy: ReturnType<typeof vi.spyOn>): CustomEvent {
  const event = spy.mock.calls.at(-1)?.[0]
  if (!(event instanceof CustomEvent)) {
    throw new Error('Expected a split request event')
  }
  return event
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

describe('requestActiveTerminalPaneSplit', () => {
  it('dispatches the active terminal pane split event', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')

    requestActiveTerminalPaneSplit({ tabId: 'term-1', direction: 'vertical' })

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const event = dispatchSpy.mock.calls[0]?.[0] as CustomEvent
    expect(event.type).toBe(REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT)
    expect(event.detail).toEqual({
      tabId: 'term-1',
      direction: 'vertical'
    })
  })
})

describe('SortableTabContextMenu', () => {
  it.each([false, true])(
    'copies the workspace ID of an inactive tab (pinned: %s)',
    async (isPinned) => {
      const writeClipboardText = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      const onRenameOpen = vi.fn()
      const apiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ui: { writeClipboardText } }
      })
      try {
        const { container, onActivate } = renderMenu({
          isActive: false,
          isPinned,
          onClose,
          onRenameOpen
        })
        await act(async () => getButton(container, 'Copy Tab ID').click())
        expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('orcaTabId: tab-1')
        expect(onActivate).not.toHaveBeenCalled()
        expect(onClose).not.toHaveBeenCalled()
        expect(onRenameOpen).not.toHaveBeenCalled()
      } finally {
        if (apiDescriptor) {
          Object.defineProperty(window, 'api', apiDescriptor)
        } else {
          Reflect.deleteProperty(window, 'api')
        }
      }
    }
  )

  it('does not expose a native/terminal view switch', () => {
    const { container } = renderMenu()

    expect(container.textContent).not.toContain('Continue with Terminal Agent')
    expect(container.textContent).not.toContain('Continue in Chat UI')
  })

  it('hides switching a terminal-view tab into chat view', () => {
    const { container } = renderMenu({ canToggleViewMode: true, onToggleViewMode: vi.fn() })

    expect(container.textContent).not.toContain('Continue in Chat UI')
  })

  it('keeps the way back for a tab already in chat view, in the chat/CLI move section', () => {
    const onToggleViewMode = vi.fn()
    const { container } = renderMenu({
      canToggleViewMode: true,
      isChatView: true,
      onToggleViewMode
    })
    const marker = getSurfaceSwitchMarker(container)

    expect(
      getButton(container, 'Continue with Terminal Agent').compareDocumentPosition(marker)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(marker.getAttribute('data-leading-separator')).toBe('false')
    act(() => getButton(container, 'Continue with Terminal Agent').click())
    expect(onToggleViewMode).toHaveBeenCalled()
  })

  it('offers the session-history chat/CLI move right above Pin Tab', () => {
    const { container } = renderMenu({ nativeChat: { sessionId: 'orca-chat-1', agent: 'codex' } })
    const marker = getSurfaceSwitchMarker(container)

    expect(marker.getAttribute('data-tab-id')).toBe('term-1')
    expect(marker.getAttribute('data-structured-session-id')).toBe('orca-chat-1')
    expect(marker.getAttribute('data-leading-separator')).toBe('true')
    expect(getButton(container, 'Split terminal').compareDocumentPosition(marker)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(marker.compareDocumentPosition(getButton(container, 'Pin Tab'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('dispatches split requests and activates inactive terminal tabs first', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const { container, onActivate } = renderMenu({ isActive: false })

    act(() => getButton(container, 'Split terminal right').click())
    expect(onActivate).toHaveBeenCalledWith('term-1')
    expect(getLastSplitEvent(dispatchSpy).detail).toEqual({
      tabId: 'term-1',
      direction: 'vertical'
    })

    dispatchSpy.mockClear()
    act(() => getButton(container, 'Split terminal down').click())
    expect(getLastSplitEvent(dispatchSpy).detail).toEqual({
      tabId: 'term-1',
      direction: 'horizontal'
    })
  })

  it('renders split actions and routes directions to the move path', () => {
    const { container } = renderMenu()

    expect(container.textContent).toContain('Move Tab to Split')
    expect(container.textContent).toContain('Split terminal')

    act(() => getButton(container, 'Right').click())
    expect(moveMock.moveTabToNewPaneColumn).toHaveBeenCalledWith({
      unifiedTabId: 'tab-1',
      groupId: 'group-1',
      direction: 'right'
    })
  })

  it('hides terminal-only split actions for structured chat tabs', () => {
    const { container } = renderMenu({ canSplitTerminal: false })

    expect(container.textContent).toContain('Move Tab to Split')
    expect(container.textContent).not.toContain('Split terminal')
  })

  it('keeps Close Others available without directional close entries', () => {
    const onCloseOthers = vi.fn()
    const { container } = renderMenu({ onCloseOthers })

    act(() => getButton(container, 'Close Others').click())
    expect(onCloseOthers).toHaveBeenCalledWith('term-1')
    expect(container.textContent).not.toContain('Close All Tabs To The Left')
    expect(container.textContent).not.toContain('Close All Tabs To The Right')
  })

  it('hides move-tab split actions for a single-tab group', () => {
    storeMock.state = {
      ...storeMock.state,
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1']
          }
        ]
      }
    }
    const { container } = renderMenu()

    expect(container.textContent).not.toContain('Move Tab to Split')
    expect(container.textContent).toContain('Split terminal right')
  })

  it('offers Close split pane only when the group is one of several splits', () => {
    const onCloseSplitPane = vi.fn()
    const { container } = renderMenu({ onCloseSplitPane })
    act(() => getButton(container, 'Close split pane').click())
    expect(onCloseSplitPane).toHaveBeenCalledOnce()

    expect(renderMenu().container.textContent).not.toContain('Close split pane')
  })
})
