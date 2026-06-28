import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalContextMenu from './TerminalContextMenu'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: passthrough,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return React.createElement(React.Fragment, null, props.children)
    }
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/hooks/useShortcutLabel', () => ({ formatShortcutLabel: () => 'X' }))
vi.mock('./terminal-context-menu-dismiss', () => ({
  shouldIgnoreTerminalMenuPointerDownOutside: () => false
}))

function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function renderMenu(overrides: Record<string, unknown> = {}): void {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    menuPoint: { x: 0, y: 0 },
    menuOpenedAtRef: { current: 0 },
    canClosePane: true,
    canExpandPane: true,
    menuPaneIsExpanded: false,
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    keybindings: {},
    canEqualizePaneSizes: false,
    onEqualizePaneSizes: vi.fn(),
    onClosePane: vi.fn(),
    onClearScreen: vi.fn(),
    onForkAgentSession: vi.fn(),
    onCopyAgentSessionContext: vi.fn(),
    repoQuickCommands: [],
    globalQuickCommands: [],
    quickCommandRepoLabel: null,
    onQuickCommand: vi.fn(),
    onAddQuickCommand: vi.fn(),
    onToggleExpand: vi.fn(),
    onSetTitle: vi.fn(),
    onCopyTerminalId: vi.fn(),
    onCopyPaneId: vi.fn(),
    ...overrides
  }
  renderToStaticMarkup(React.createElement(TerminalContextMenu, props))
}

describe('TerminalContextMenu', () => {
  beforeEach(() => {
    items.list = []
  })

  it('renders a "Copy Context" item that triggers onCopyAgentSessionContext (issue #5020)', () => {
    const onCopyAgentSessionContext = vi.fn()
    const onForkAgentSession = vi.fn()
    renderMenu({ onCopyAgentSessionContext, onForkAgentSession })

    const copyContextItem = items.list.find(
      (item) => childrenText(item.children) === 'Copy Context'
    )
    expect(copyContextItem).toBeDefined()

    copyContextItem?.onSelect?.()
    expect(onCopyAgentSessionContext).toHaveBeenCalledTimes(1)
    // Why: copying context must not go through the fork dialog path.
    expect(onForkAgentSession).not.toHaveBeenCalled()
  })
})
