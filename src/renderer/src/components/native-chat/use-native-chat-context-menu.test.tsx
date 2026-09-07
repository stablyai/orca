/**
 * @vitest-environment happy-dom
 */
import React, { createRef, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'

type ItemProps = { onSelect?: () => void; children?: ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuItem: (props: ItemProps) => {
    items.list.push(props)
    return props.children
  },
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => children
}))

vi.mock('lucide-react', () => {
  const Icon = () => null
  return {
    Clipboard: Icon,
    Copy: Icon,
    GitFork: Icon,
    Maximize2: Icon,
    MessageSquarePlus: Icon,
    Minimize2: Icon,
    PanelBottomClose: Icon,
    PanelsTopLeft: Icon,
    PanelRightClose: Icon,
    Pencil: Icon,
    SquareTerminal: Icon,
    X: Icon
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/tab-bar/TabWorkspaceLayoutMenuSection', () => ({
  TabWorkspaceLayoutMenuSection: () => 'Move Tab to Split'
}))

function childrenText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') {
        return child
      }
      return React.isValidElement<{ children?: ReactNode }>(child)
        ? childrenText(child.props.children)
        : ''
    })
    .join('')
}

function Harness({
  onSwitchToTerminal,
  structured = false,
  enabled = true
}: {
  onSwitchToTerminal?: () => void
  structured?: boolean
  enabled?: boolean
}) {
  const rootRef = createRef<HTMLDivElement>()
  const { menu } = useNativeChatContextMenu({
    rootRef,
    enabled,
    onSwitchToTerminal,
    showTerminalPaneActions: !structured,
    workspaceLayout: structured ? { unifiedTabId: 'chat-tab', groupId: 'group-1' } : undefined,
    actions: {
      ...emptyNativeChatContextMenuActions,
      onPaste: vi.fn()
    } satisfies NativeChatContextMenuActions
  })
  return menu
}

describe('useNativeChatContextMenu', () => {
  beforeEach(() => {
    items.list = []
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('restores the bridge switch-to-terminal action when supplied', () => {
    const onSwitchToTerminal = vi.fn()

    renderToStaticMarkup(<Harness onSwitchToTerminal={onSwitchToTerminal} />)

    // Keep the assertions tied to the mocked menu item's semantic children.
    const labels = items.list.map((candidate) => childrenText(candidate.children))

    expect(labels.some((label) => label.startsWith('Switch to terminal view'))).toBe(true)
    const item = items.list.find((candidate) =>
      childrenText(candidate.children).startsWith('Switch to terminal view')
    )
    expect(item).toBeDefined()
    item?.onSelect?.()
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not render a terminal switch action without a bridge callback', () => {
    renderToStaticMarkup(<Harness />)

    expect(
      items.list.some((candidate) => childrenText(candidate.children) === 'Switch to terminal view')
    ).toBe(false)
  })

  it('reuses workspace layout actions without terminal-only pane commands', () => {
    const markup = renderToStaticMarkup(<Harness structured />)

    expect(markup).toContain('Move Tab to Split')
    expect(markup).not.toContain('Split Terminal Right')
    expect(markup).not.toContain('Fork Agent Session')
  })

  it('subscribes to selection changes only while its retained chat is visible', () => {
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(null)
    const view = render(<Harness enabled={false} />)

    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).not.toHaveBeenCalled()

    view.rerender(<Harness enabled />)
    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).toHaveBeenCalledOnce()

    view.rerender(<Harness enabled={false} />)
    getSelection.mockClear()
    document.dispatchEvent(new Event('selectionchange'))
    expect(getSelection).not.toHaveBeenCalled()
  })
})
