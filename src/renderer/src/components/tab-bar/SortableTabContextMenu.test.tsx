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
  dropUnifiedTab: vi.fn(),
  getMainBufferSnapshot: vi.fn(),
  openWindow: vi.fn(),
  serializeRegisteredPtyBuffer: vi.fn(),
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

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuItem: ({
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
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('lucide-react', () => ({
  ArrowDown: () => null,
  ArrowLeft: () => null,
  ArrowRight: () => null,
  ArrowUp: () => null,
  Columns2: () => null,
  ListX: () => null,
  MessageSquare: () => null,
  PanelBottomClose: () => null,
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

vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  serializeRegisteredPtyBuffer: storeMock.serializeRegisteredPtyBuffer
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
        tab={{
          id: 'term-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'bash',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }}
        unifiedTabId="tab-1"
        groupId="group-1"
        isActive
        open
        point={{ x: 0, y: 0 }}
        tabCount={2}
        hasTabsToRight
        isPinned={false}
        onOpenChange={vi.fn()}
        onActivate={onActivate}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
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

function getLastSplitEvent(spy: ReturnType<typeof vi.spyOn>): CustomEvent {
  const event = spy.mock.calls.at(-1)?.[0]
  if (!(event instanceof CustomEvent)) {
    throw new Error('Expected a split request event')
  }
  return event
}

beforeEach(() => {
  storeMock.dropUnifiedTab.mockReset()
  storeMock.getMainBufferSnapshot.mockReset().mockResolvedValue({
    data: 'main-buffer',
    cols: 80,
    rows: 24,
    source: 'headless'
  })
  storeMock.openWindow.mockReset().mockResolvedValue({ ok: true })
  storeMock.serializeRegisteredPtyBuffer.mockReset().mockResolvedValue({
    data: 'renderer-buffer',
    cols: 80,
    rows: 24,
    source: 'renderer'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { getMainBufferSnapshot: storeMock.getMainBufferSnapshot },
      detachedTerminal: { openWindow: storeMock.openWindow }
    }
  })
  storeMock.state = {
    keybindings: {},
    dropUnifiedTab: storeMock.dropUnifiedTab,
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
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'group-1' } },
    terminalLayoutsByTabId: {
      'term-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
      }
    },
    repos: [{ id: 'repo-1', path: '/tmp/repo' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt' }] },
    settings: {},
    keybindingSnapshot: null
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
    storeMock.dropUnifiedTab.mockReturnValue(true)
    const { container } = renderMenu()

    expect(container.textContent).toContain('Move Tab to Split')
    expect(container.textContent).toContain('Split terminal')

    act(() => getButton(container, 'Right').click())
    expect(storeMock.dropUnifiedTab).toHaveBeenCalledWith('tab-1', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
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

  it('selects Open in New Window with a fresh snapshot payload', async () => {
    const { container } = renderMenu()

    await act(async () => {
      getButton(container, 'Open in New Window').click()
    })

    expect(storeMock.getMainBufferSnapshot).toHaveBeenCalledWith('pty-1', { scrollbackRows: 5000 })
    expect(storeMock.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        tabId: 'term-1',
        snapshot: expect.objectContaining({
          terminalLayout: expect.objectContaining({
            ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
          }),
          bufferSnapshotsByLeafId: {
            'leaf-1': expect.objectContaining({ data: 'main-buffer' })
          }
        })
      })
    )
  })

  it('targets the right-clicked inactive terminal tab when staging a detached snapshot', async () => {
    storeMock.state = {
      ...storeMock.state,
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
          },
          {
            id: 'tab-2',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'terminal',
            entityId: 'term-2',
            label: 'zsh',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
        },
        'term-2': {
          root: { type: 'leaf', leafId: 'leaf-2' },
          activeLeafId: 'leaf-2',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-2': 'pty-2' }
        }
      },
      activeTabIdByWorktree: { 'wt-1': 'tab-1' }
    }
    const { container } = renderMenu({
      isActive: false,
      tab: {
        id: 'term-2',
        ptyId: 'pty-2',
        worktreeId: 'wt-1',
        title: 'zsh',
        customTitle: null,
        color: null,
        sortOrder: 1,
        createdAt: 1
      },
      unifiedTabId: 'tab-2'
    })

    await act(async () => {
      getButton(container, 'Open in New Window').click()
    })

    expect(storeMock.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          activeGroupId: 'group-1',
          activeTabId: 'tab-2'
        })
      })
    )
  })

  it('keeps Open in New Window enabled for a split tab with only layout PTYs', async () => {
    storeMock.state = {
      ...storeMock.state,
      terminalLayoutsByTabId: {
        'term-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
        }
      }
    }
    const { container } = renderMenu()

    await act(async () => {
      getButton(container, 'Open in New Window').click()
    })

    expect(storeMock.openWindow).toHaveBeenCalled()
    expect(getButton(container, 'Open in New Window').disabled).toBe(false)
  })

  it('falls back to renderer serialization when main has no buffer snapshot', async () => {
    storeMock.getMainBufferSnapshot.mockResolvedValue(null)
    const { container } = renderMenu()

    await act(async () => {
      getButton(container, 'Open in New Window').click()
    })

    expect(storeMock.serializeRegisteredPtyBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
    expect(storeMock.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          bufferSnapshotsByLeafId: {
            'leaf-1': expect.objectContaining({ data: 'renderer-buffer' })
          }
        })
      })
    )
  })
})
