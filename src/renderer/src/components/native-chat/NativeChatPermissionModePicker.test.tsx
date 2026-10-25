// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  const Selection = React.createContext<string | undefined>(undefined)
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({
      children,
      disabled
    }: {
      children: React.ReactNode
      disabled?: boolean
    }) => (
      <div data-testid="permission-trigger" data-disabled={disabled || undefined}>
        {children}
      </div>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="permission-menu">{children}</div>
    ),
    DropdownMenuRadioGroup: ({
      children,
      value,
      'aria-label': ariaLabel
    }: {
      children: React.ReactNode
      value?: string
      'aria-label'?: string
    }) => (
      <Selection.Provider value={value}>
        <div role="radiogroup" aria-label={ariaLabel}>
          {children}
        </div>
      </Selection.Provider>
    ),
    DropdownMenuRadioItem: ({
      children,
      value,
      disabled,
      onSelect
    }: {
      children: React.ReactNode
      value: string
      disabled?: boolean
      onSelect?: () => void
    }) => (
      <button
        role="radio"
        aria-checked={React.useContext(Selection) === value}
        disabled={disabled}
        data-value={value}
        onClick={onSelect}
      >
        {children}
      </button>
    )
  }
})

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  NativeChatComposerPermissionPicker,
  NativeChatPermissionModePicker,
  type NativeChatPermissionModePickerProps
} from './NativeChatPermissionModePicker'

function props(
  overrides: Partial<NativeChatPermissionModePickerProps> = {}
): NativeChatPermissionModePickerProps {
  return {
    agent: 'claude',
    current: 'ask',
    modes: ['ask', 'accept-edits', 'auto', 'full-access'],
    onSelect: vi.fn(),
    ...overrides
  }
}

function option(mode: AgentChatPermissionMode): HTMLElement {
  return screen.getByRole('radio', {
    name: (_name, element) => element.getAttribute('data-value') === mode
  })
}

afterEach(cleanup)

describe('NativeChatPermissionModePicker', () => {
  it('lists each mode the agent offers, in order, with what it does', () => {
    render(<NativeChatPermissionModePicker {...props()} />)

    const menu = screen.getByTestId('permission-menu')
    expect(
      within(menu)
        .getAllByRole('radio')
        .map((row) => row.getAttribute('data-value'))
    ).toEqual(['ask', 'accept-edits', 'auto', 'full-access'])
    expect(within(menu).getByText('Ask for approval')).toBeTruthy()
    expect(
      within(menu).getByText("Asks before edits and commands your settings don't allow")
    ).toBeTruthy()
    expect(
      within(menu).getByText('Approves file edits and file commands; asks for the rest')
    ).toBeTruthy()
    expect(within(menu).getByText('Reviews approval requests for you')).toBeTruthy()
    expect(within(menu).getByText('Never asks before edits or commands')).toBeTruthy()
  })

  it("describes Codex's modes as Codex runs them", () => {
    render(
      <NativeChatPermissionModePicker
        {...props({ agent: 'codex', modes: ['ask', 'auto', 'full-access'] })}
      />
    )
    expect(screen.queryByText('Accept edits')).toBeNull()
    expect(option('ask').textContent).toContain(
      'Edits files and runs commands in this workspace; asks before anything else'
    )
    expect(option('full-access').textContent).toContain(
      'Never asks; can edit any file and use the network'
    )
  })

  it('describes both agents in the new-chat setting', () => {
    render(<NativeChatPermissionModePicker {...props({ agent: null })} />)
    expect(option('ask').textContent).toContain(
      "Asks before edits or commands it isn't already allowed to make"
    )
    expect(option('full-access').textContent).toContain('Never asks before edits or commands')
  })

  it('names the current mode on the pill, by category for assistive tech', () => {
    render(<NativeChatPermissionModePicker {...props({ current: 'auto' })} />)
    const trigger = screen.getByRole('button', { name: 'Permissions Approve for me' })
    expect(trigger.textContent).toContain('Approve for me')
    expect(option('auto').getAttribute('aria-checked')).toBe('true')
  })

  it('shows Full access in the warning colour on the pill and in the menu', () => {
    render(<NativeChatPermissionModePicker {...props({ current: 'full-access' })} />)

    const trigger = screen.getByRole('button', { name: 'Permissions Full access' })
    expect(trigger.querySelector('.text-status-warning')?.textContent).toBe('Full access')
    expect(option('full-access').querySelector('.text-status-warning')).not.toBeNull()
    expect(option('ask').querySelector('.text-status-warning')).toBeNull()
  })

  it('locks the pill and its rows while disabled', () => {
    render(<NativeChatPermissionModePicker {...props({ disabled: true })} />)
    expect(screen.getByTestId('permission-trigger').getAttribute('data-disabled')).toBe('true')
    expect(option('full-access')).toHaveProperty('disabled', true)
  })
})

describe('NativeChatComposerPermissionPicker', () => {
  const descriptor = (
    overrides: Partial<SessionOptionDescriptor> = {}
  ): SessionOptionDescriptor => ({
    id: 'permissionMode',
    label: 'Permissions',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: 'ask',
      choices: [
        { value: 'ask', label: 'Ask for approval' },
        { value: 'auto', label: 'Approve for me' },
        { value: 'full-access', label: 'Full access' }
      ]
    },
    valueSource: 'applied',
    transport: 'agent-session',
    settable: true,
    ...overrides
  })
  const surface = () => ({
    getSnapshot: () => [],
    setOption: vi.fn(async () => ({ snapshot: [] })),
    invokeAction: vi.fn(async () => ({ snapshot: [] })),
    subscribe: () => () => {}
  })

  it('renders nothing without a permission descriptor', () => {
    const { container } = render(
      <NativeChatComposerPermissionPicker surface={surface()} snapshot={[]} agent="codex" />
    )
    expect(container.innerHTML).toBe('')
  })

  it('writes a new pick through the option surface, and skips the current one', () => {
    const options = surface()
    render(
      <NativeChatComposerPermissionPicker
        surface={options}
        snapshot={[descriptor()]}
        agent="codex"
      />
    )
    fireEvent.click(option('ask'))
    expect(options.setOption).not.toHaveBeenCalled()
    // A write that waits behind a starting agent leaves the pill usable.
    options.setOption.mockImplementation(() => new Promise(() => {}))
    fireEvent.click(option('full-access'))
    expect(options.setOption).toHaveBeenCalledWith('permissionMode', 'full-access')
    expect(screen.getByTestId('permission-trigger').getAttribute('data-disabled')).toBeNull()
  })

  it('locks only while the descriptor cannot take a pick', () => {
    render(
      <NativeChatComposerPermissionPicker
        surface={surface()}
        snapshot={[descriptor({ settable: false })]}
        agent="codex"
      />
    )
    expect(screen.getByTestId('permission-trigger').getAttribute('data-disabled')).toBe('true')
  })
})
