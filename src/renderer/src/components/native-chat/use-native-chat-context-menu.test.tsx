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

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const tooltips = vi.hoisted((): { list: ReactNode[] } => ({ list: [] }))
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: { children?: ReactNode }) => children
  return {
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: ({ children }: { children?: ReactNode }) => {
      tooltips.list.push(children)
      return null
    }
  }
})

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
  enabled = true,
  orcaSessionId
}: {
  onSwitchToTerminal?: () => void
  structured?: boolean
  enabled?: boolean
  orcaSessionId?: string
}) {
  const rootRef = createRef<HTMLDivElement>()
  const { menu } = useNativeChatContextMenu({
    rootRef,
    enabled,
    onSwitchToTerminal,
    showTerminalPaneActions: !structured,
    workspaceLayout: structured ? { unifiedTabId: 'chat-tab', groupId: 'group-1' } : undefined,
    resolveOrcaSessionId: orcaSessionId === undefined ? undefined : async () => orcaSessionId,
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

  describe('Copy Orca Session ID', () => {
    const orcaSessionId = 'orca_session_id:4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
    const writeClipboardText = vi.fn()

    beforeEach(() => {
      writeClipboardText.mockReset().mockResolvedValue(undefined)
      toasts.success.mockReset()
      toasts.error.mockReset()
      tooltips.list = []
      Object.assign(window, { api: { ui: { writeClipboardText } } })
    })

    function labels(): string[] {
      return items.list.map((candidate) => childrenText(candidate.children))
    }

    function copyItem(): ItemProps | undefined {
      return items.list.find(
        (candidate) => childrenText(candidate.children) === 'Copy Orca Session ID'
      )
    }

    it('copies the Orca session ID in a chat tab, explaining what it is', async () => {
      renderToStaticMarkup(<Harness structured orcaSessionId={orcaSessionId} />)

      copyItem()?.onSelect?.()

      await vi.waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Orca session ID copied'))
      expect(writeClipboardText).toHaveBeenCalledWith(orcaSessionId)
      expect(tooltips.list.map(childrenText)).toContain(
        "Orca's ID for this chat, separate from the agent CLI's own session ID. Agents use it to refer to each other through Orca."
      )
    })

    it('is absent for a chat with no Orca session ID', () => {
      renderToStaticMarkup(<Harness structured />)

      expect(labels()).not.toContain('Copy Orca Session ID')
    })

    it('reports a failed copy instead of claiming success', async () => {
      writeClipboardText.mockRejectedValue(new Error('denied'))
      renderToStaticMarkup(<Harness structured orcaSessionId={orcaSessionId} />)

      copyItem()?.onSelect?.()

      await vi.waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith('Unable to copy Orca session ID')
      )
      expect(toasts.success).not.toHaveBeenCalled()
    })
  })
})
