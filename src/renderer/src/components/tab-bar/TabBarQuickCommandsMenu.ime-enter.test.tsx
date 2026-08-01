// @vitest-environment happy-dom

import React, { act } from 'react'
import type * as ReactNamespace from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabBarQuickCommandsMenu } from './TabBarQuickCommandsMenu'
import type { TerminalQuickCommand } from '../../../../shared/types'

vi.mock('@/components/ui/command', async () => {
  const react = await vi.importActual<typeof ReactNamespace>('react')
  return {
    Command: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CommandEmpty: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    CommandInput: react.forwardRef<
      HTMLInputElement,
      { onKeyDown?: React.KeyboardEventHandler<HTMLInputElement> }
    >(({ onKeyDown }, ref) => (
      <input ref={ref} data-quick-command-search="true" onKeyDown={onKeyDown} />
    )),
    CommandList: react.forwardRef<HTMLDivElement, { children?: React.ReactNode }>(
      ({ children }, ref) => <div ref={ref}>{children}</div>
    ),
    CommandSeparator: () => <div />
  }
})

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({
    children,
    onKeyDown
  }: {
    children?: React.ReactNode
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
  }) => <div onKeyDown={onKeyDown}>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ShortcutKeyCombo', () => ({
  ShortcutKeyCombo: () => <span />
}))

vi.mock('./TabBarQuickCommandItem', () => ({
  TabBarQuickCommandItem: () => <div />
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyComboDetails: () => []
}))

vi.mock('./tab-bar-quick-commands-shortcut', () => ({
  useTabBarQuickCommandsShortcut: () => undefined
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => agent
}))

vi.mock('../../../../shared/terminal-quick-commands', () => ({
  getTerminalQuickCommandBody: (command: { command?: string }) => command.command ?? '',
  isTerminalAgentQuickCommand: () => false
}))

// Why: the picker's real ranking is not under test — pin it so the highlighted
// row is deterministic and Enter has an unambiguous target.
vi.mock('@/lib/terminal-quick-command-search', () => ({
  searchTerminalQuickCommands: (commands: readonly TerminalQuickCommand[]) => [...commands],
  getTerminalQuickCommandPickerValue: ({
    filteredCommands
  }: {
    filteredCommands: readonly TerminalQuickCommand[]
  }) => filteredCommands[0]?.id ?? ''
}))

const DEPLOY: TerminalQuickCommand = {
  id: 'cmd-deploy',
  label: '배포',
  command: 'echo 배포',
  appendEnter: true
}

const RESET: TerminalQuickCommand = {
  id: 'cmd-reset',
  label: '초기화',
  command: 'echo 초기화',
  appendEnter: true
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function renderMenu(onRunCommand: (command: TerminalQuickCommand) => void): HTMLInputElement {
  act(() => {
    root.render(
      <TabBarQuickCommandsMenu
        repoCommands={[DEPLOY, RESET]}
        globalCommands={[]}
        mostRecent={null}
        onAddCommand={vi.fn()}
        onDeleteCommand={vi.fn()}
        onEditCommand={vi.fn()}
        onRunCommand={onRunCommand}
      />
    )
  })
  const input = container.querySelector<HTMLInputElement>('[data-quick-command-search="true"]')
  if (!input) {
    throw new Error('quick commands search input not rendered')
  }
  return input
}

function pressKey(
  input: HTMLInputElement,
  key: string,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

describe('TabBarQuickCommandsMenu IME Enter guard', () => {
  it('does not run the highlighted command on the Enter that commits a CJK composition', () => {
    const onRunCommand = vi.fn()
    const input = renderMenu(onRunCommand)

    pressKey(input, 'Enter', { isComposing: true })

    expect(onRunCommand).not.toHaveBeenCalled()
  })

  it('does not run the highlighted command on an Enter reported as keyCode 229', () => {
    const onRunCommand = vi.fn()
    const input = renderMenu(onRunCommand)

    pressKey(input, 'Enter', { keyCode: 229 })

    expect(onRunCommand).not.toHaveBeenCalled()
  })

  it('still runs the highlighted command on a plain Enter', () => {
    const onRunCommand = vi.fn()
    const input = renderMenu(onRunCommand)

    pressKey(input, 'Enter')

    expect(onRunCommand).toHaveBeenCalledTimes(1)
    expect(onRunCommand).toHaveBeenCalledWith(DEPLOY)
  })

  it('leaves the highlighted row alone when an arrow key belongs to the IME', () => {
    const onRunCommand = vi.fn()
    const input = renderMenu(onRunCommand)

    // The composing ArrowDown must not move the selection, so the following
    // plain Enter still runs the first command.
    pressKey(input, 'ArrowDown', { isComposing: true })
    pressKey(input, 'Enter')

    expect(onRunCommand).toHaveBeenCalledWith(DEPLOY)
  })

  it('still moves the highlighted row on a plain arrow key (control for the guard)', () => {
    const onRunCommand = vi.fn()
    const input = renderMenu(onRunCommand)

    // Proves the case above was suppressed by the guard rather than inert:
    // without composition the same ArrowDown advances to the second command.
    pressKey(input, 'ArrowDown')
    pressKey(input, 'Enter')

    expect(onRunCommand).toHaveBeenCalledWith(RESET)
  })
})
