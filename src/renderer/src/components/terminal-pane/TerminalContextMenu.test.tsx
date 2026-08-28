import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalContextMenu from './TerminalContextMenu'
import type { KeybindingOverrides } from '../../../../shared/keybindings'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const shortcuts = vi.hoisted(() => ({ list: [] as string[] }))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuLabel: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuShortcut: ({ children }: { children?: React.ReactNode }) => {
      shortcuts.list.push(
        React_.Children.toArray(children)
          .filter((child): child is string => typeof child === 'string')
          .join('')
      )
      return React_.createElement(React_.Fragment, null, children)
    },
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
vi.mock('./terminal-context-menu-dismiss', () => ({
  shouldIgnoreTerminalMenuPointerDownOutside: () => false
}))

function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') {
        return child
      }
      return React.isValidElement<{ children?: React.ReactNode }>(child)
        ? childrenText(child.props.children)
        : ''
    })
    .join('')
}

function renderMenu(overrides: Record<string, unknown> = {}): string {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    menuPoint: { x: 0, y: 0 },
    menuOpenedAtRef: { current: 0 },
    canClosePane: true,
    canExpandPane: true,
    menuPaneIsExpanded: false,
    onCopy: vi.fn(),
    onSelectAll: vi.fn(),
    onPaste: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    keybindings: {},
    canEqualizePaneSizes: false,
    onEqualizePaneSizes: vi.fn(),
    onClosePane: vi.fn(),
    onClearScreen: vi.fn(),
    canContinueAgentSessionInNewSession: false,
    onContinueAgentSessionInNewSession: vi.fn(),
    onForkAgentSession: vi.fn(),
    canToggleNativeChat: false,
    isNativeChatView: false,
    onToggleNativeChat: vi.fn(),
    onCopyAgentSessionContext: vi.fn(),
    quickCommandHosts: [
      { hostId: 'local' as const, label: 'Local Linux', repoCommands: [], globalCommands: [] }
    ],
    quickCommandHostLoadFailed: false,
    quickCommandHostOwnershipPending: false,
    quickCommandRepoLabel: 'Orca',
    onQuickCommand: vi.fn(),
    onAddQuickCommand: vi.fn(),
    onToggleExpand: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    canClearPaneTitle: false,
    onCopyTerminalId: vi.fn(),
    onCopyPaneId: vi.fn(),
    ...overrides
  }
  return renderToStaticMarkup(React.createElement(TerminalContextMenu, props))
}

describe('TerminalContextMenu', () => {
  beforeEach(() => {
    items.list = []
    shortcuts.list = []
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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

  it('shows new-session continuation only for eligible agent panes', () => {
    const onContinueAgentSessionInNewSession = vi.fn()
    renderMenu({
      canContinueAgentSessionInNewSession: true,
      onContinueAgentSessionInNewSession
    })

    const handoffItem = items.list.find(
      (item) => childrenText(item.children) === 'Continue in New Session…'
    )
    expect(handoffItem).toBeDefined()

    handoffItem?.onSelect?.()
    expect(onContinueAgentSessionInNewSession).toHaveBeenCalledTimes(1)
  })

  it('shows one shortcut per terminal menu action on Windows', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    })
    const keybindings = {
      'terminal.copySelection': ['Ctrl+Shift+C', 'Ctrl+Insert', 'Ctrl+C'],
      'terminal.selectAll': ['Ctrl+Shift+A'],
      'terminal.splitRight': ['Mod+Shift+D', 'Alt+Shift+Right'],
      'terminal.splitDown': ['Alt+Shift+D', 'Mod+Shift+Minus']
    } satisfies KeybindingOverrides

    renderMenu({ keybindings })

    expect(shortcuts.list).toContain('Ctrl+Shift+C')
    expect(shortcuts.list).toContain('Ctrl+Shift+A')
    expect(shortcuts.list).toContain('Ctrl+V')
    expect(shortcuts.list).toContain('Ctrl+Shift+D')
    expect(shortcuts.list).toContain('Alt+Shift+D')
    expect(shortcuts.list.some((shortcut) => shortcut.includes(','))).toBe(false)
  })

  it('labels commands and add actions by their owning host', () => {
    const onAddQuickCommand = vi.fn()
    const rendered = renderMenu({
      onAddQuickCommand,
      quickCommandHosts: [
        {
          hostId: 'local',
          label: 'Local Mac',
          repoCommands: [],
          globalCommands: [
            {
              id: 'local-review',
              label: 'Review',
              command: 'review',
              appendEnter: true
            }
          ]
        },
        {
          hostId: 'runtime:build',
          label: 'Build Server',
          repoCommands: [],
          globalCommands: [
            {
              id: 'deploy',
              label: 'Deploy',
              command: 'deploy',
              appendEnter: true
            }
          ]
        }
      ]
    })

    const markup = items.list.map((item) => childrenText(item.children)).join('\n')
    expect(rendered).toContain('Local Mac')
    expect(rendered).toContain('Build Server')
    expect(markup.match(/Add to \{\{value0\}\}…/g)).toHaveLength(2)

    const addItems = items.list.filter(
      (item) => childrenText(item.children) === 'Add to {{value0}}…'
    )
    addItems.forEach((item) => item.onSelect?.())
    expect(onAddQuickCommand.mock.calls.map(([hostId]) => hostId)).toEqual([
      'local',
      'runtime:build'
    ])
  })

  it('preserves repo and global grouping when only the local host is available', () => {
    const rendered = renderMenu({
      quickCommandHosts: [
        {
          hostId: 'local',
          label: 'Local Mac',
          repoCommands: [{ id: 'repo', label: 'Repo command', command: 'repo', appendEnter: true }],
          globalCommands: [
            { id: 'global', label: 'Global command', command: 'global', appendEnter: true }
          ]
        }
      ]
    })

    expect(rendered).toContain('Orca')
    expect(rendered).toContain('Global')
    expect(rendered).not.toContain('Local Mac')
  })

  it('passes hosted identity when running a command', () => {
    const onQuickCommand = vi.fn()
    const command = {
      id: 'review',
      label: 'Remote review',
      action: 'agent-prompt' as const,
      agent: 'codex' as const,
      prompt: 'Review this change',
      scope: { type: 'global' as const }
    }
    renderMenu({
      onQuickCommand,
      quickCommandHosts: [
        {
          hostId: 'runtime:build',
          label: 'Build Server',
          repoCommands: [],
          globalCommands: [command]
        }
      ]
    })

    const commandItem = items.list.find((item) => childrenText(item.children) === 'Remote review')
    commandItem?.onSelect?.()

    expect(onQuickCommand).toHaveBeenCalledWith(command, 'runtime:build\0review')
  })

  it('suppresses add actions while remote host ownership is loading', () => {
    const rendered = renderMenu({ quickCommandHostOwnershipPending: true })

    expect(rendered).toContain('Loading host…')
    expect(rendered).not.toContain('Add Quick Command…')
  })
})
