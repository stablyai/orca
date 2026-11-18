// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

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

import {
  NativeChatPermissionModePicker,
  type NativeChatPermissionModePickerProps
} from './session/options/controls/NativeChatPermissionModePicker'

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

function option(mode: AgentChatPermissionChoice): HTMLElement {
  return screen.getByRole('radio', {
    name: (_name, element) => element.getAttribute('data-value') === mode
  })
}

afterEach(cleanup)

describe('NativeChatPermissionModePicker inherit choice', () => {
  const inherit = (onSelect = vi.fn()) => ({
    label: 'Same as chats',
    description: 'Starts like any new chat',
    onSelect
  })
  const inheritRow = () =>
    screen.getByRole('radio', {
      name: (_name, element) => element.getAttribute('data-value') === 'inherit'
    })

  it('leads the menu and is current while no mode is set', () => {
    const onSelect = vi.fn()
    render(
      <NativeChatPermissionModePicker
        {...props({ current: undefined, inherit: inherit(onSelect) })}
      />
    )

    expect(within(screen.getByTestId('permission-trigger')).getByText('Same as chats')).toBeTruthy()
    expect(screen.getAllByRole('radio')[0]).toBe(inheritRow())
    expect(inheritRow().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(inheritRow())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('gives way to a set mode', () => {
    render(<NativeChatPermissionModePicker {...props({ current: 'auto', inherit: inherit() })} />)

    expect(inheritRow().getAttribute('aria-checked')).toBe('false')
    expect(option('auto').getAttribute('aria-checked')).toBe('true')
  })
})
