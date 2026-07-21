// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) => {
    if (!values) {
      return fallback
    }
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
  }
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

vi.mock('@/components/ui/dropdown-menu', () => {
  const React = require('react') as typeof ReactModule
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({
      children,
      disabled
    }: {
      children: React.ReactNode
      disabled?: boolean
    }) => <div data-disabled={disabled || undefined}>{children}</div>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { onSelect?: () => void }) => (
      <button disabled={disabled} onClick={() => onSelect?.()}>
        {children}
      </button>
    ),
    // Why: exercises value binding + onValueChange contract the real Radix
    // group provides; selected value is exposed via data-radio-value.
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange
    }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (value: string) => void
    }) => (
      <div
        role="radiogroup"
        data-radio-value={value ?? ''}
        data-on-value-change={onValueChange ? '1' : '0'}
      >
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) {
            return child
          }
          const props = child.props as {
            value?: string
            disabled?: boolean
            children?: React.ReactNode
          }
          const selected = props.value !== undefined && props.value === value
          return (
            <button
              key={props.value}
              role="radio"
              aria-checked={selected}
              disabled={props.disabled}
              data-value={props.value}
              data-state={selected ? 'checked' : 'unchecked'}
              onClick={() => {
                if (props.value !== undefined) {
                  onValueChange?.(props.value)
                }
              }}
            >
              {props.children}
            </button>
          )
        })}
      </div>
    ),
    DropdownMenuRadioItem: ({
      children,
      disabled,
      value
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) => (
      // Why: parent RadioGroup mock reads `value` via Children.map — keep it on
      // props even though native span has no value attribute.
      <span
        data-radio-item
        data-disabled={disabled || undefined}
        {...({ value } as Record<string, string>)}
      >
        {children}
      </span>
    )
  }
})

import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn(),
  invokeAction: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}

function model(overrides: Partial<SessionOptionDescriptor> = {}): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: {
      type: 'select',
      currentValue: 'opus',
      choices: [
        { value: 'opus', label: 'Opus 4.8' },
        { value: 'sonnet', label: 'Sonnet 5' }
      ]
    },
    valueSource: 'applied',
    settable: true,
    ...overrides
  }
}

const effort: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    currentValue: 'high',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  },
  valueSource: 'applied',
  settable: true
}

const fast: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: true },
  valueSource: 'applied',
  settable: true
}

afterEach(() => cleanup())

describe('NativeChatSessionOptionPickers', () => {
  it('renders model and joined option labels, and hides an empty options pill', () => {
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort, fast]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Model Opus 4.8' }).textContent).toContain('Opus 4.8')
    expect(screen.getByRole('button', { name: 'Model Opus 4.8' }).textContent).not.toContain(
      'Model:'
    )
    expect(screen.getByRole('button', { name: 'Effort High · Fast' }).textContent).toContain(
      'High · Fast'
    )
    expect(
      screen
        .getByRole('button', { name: 'Effort High · Fast' })
        .compareDocumentPosition(screen.getByRole('button', { name: 'Model Opus 4.8' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0)

    rerender(
      <NativeChatSessionOptionPickers surface={surface} snapshot={[model()]} isWorking={false} />
    )
    expect(screen.queryByRole('button', { name: /Effort/ })).toBeNull()
  })

  it('names a lone unknown effort control explicitly', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          { ...effort, kind: { ...effort.kind, currentValue: undefined }, valueSource: 'unknown' }
        ]}
        isWorking={false}
      />
    )

    expect(screen.getByRole('button', { name: 'Effort' }).textContent).toContain('Effort')
  })

  it('disables both picker triggers while the agent is working', () => {
    render(
      <NativeChatSessionOptionPickers surface={surface} snapshot={[model(), effort]} isWorking />
    )
    expect(
      screen
        .getByRole('button', { name: 'Model Opus 4.8' })
        .parentElement?.getAttribute('data-disabled')
    ).toBe('true')
    expect(
      screen
        .getByRole('button', { name: 'Effort High' })
        .parentElement?.getAttribute('data-disabled')
    ).toBe('true')
  })

  it('does not duplicate titles for unknown values or misname generic controls', () => {
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model({
            kind: { type: 'select', choices: [] },
            valueSource: 'unknown'
          }),
          { ...effort, kind: { ...effort.kind, currentValue: undefined }, valueSource: 'unknown' }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toContain('Model')
    expect(screen.getByRole('button', { name: 'Model' }).textContent).not.toContain('Model: Model')
    expect(screen.getByRole('button', { name: 'Effort' }).textContent).not.toContain(
      'Effort: Effort'
    )

    rerender(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), fast]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Session options Fast' }).textContent).toContain(
      'Fast'
    )
    expect(screen.queryByRole('button', { name: /^Effort/ })).toBeNull()
  })

  it('shows the unconfirmed hint for dispatched values', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model({ valueSource: 'dispatched' })]}
        isWorking={false}
      />
    )
    expect(screen.getByText('Sent to the agent — not confirmed')).not.toBeNull()
  })

  it('renders agent-picker routes as one action instead of radio choices', async () => {
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, invokeAction }
    render(
      <NativeChatSessionOptionPickers
        surface={liveSurface}
        snapshot={[
          model({
            kind: {
              type: 'select',
              choices: [
                { value: 'gpt-5.5', label: 'GPT-5.5' },
                { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }
              ]
            },
            valueSource: 'unknown',
            action: { type: 'agent-picker' }
          })
        ]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Choose in agent picker…' })).not.toBeNull()
    expect(screen.queryByText('GPT-5.5')).toBeNull()
    expect(screen.queryByText('GPT-5.2 Codex')).toBeNull()
    screen.getByRole('button', { name: 'Choose in agent picker…' }).click()
    await waitFor(() => expect(invokeAction).toHaveBeenCalledWith('model'))
  })

  it('uses a Toggle action for unknown flip-only options via invokeAction', async () => {
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, setOption, invokeAction }
    render(
      <NativeChatSessionOptionPickers
        surface={liveSurface}
        snapshot={[
          model(),
          {
            ...fast,
            kind: { type: 'boolean' },
            valueSource: 'unknown',
            action: { type: 'toggle-command' }
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getByText('Toggle fast mode')).not.toBeNull()
    expect(screen.queryByText('On')).toBeNull()
    expect(screen.queryByText('Off')).toBeNull()
    screen.getByText('Toggle fast mode').click()
    await waitFor(() => expect(invokeAction).toHaveBeenCalledWith('fastMode'))
    expect(setOption).not.toHaveBeenCalled()
  })

  it('uses On/Off radios for known boolean options without inventing a selection', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, setOption }
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={liveSurface}
        snapshot={[
          model(),
          {
            ...fast,
            kind: { type: 'boolean', currentValue: true },
            valueSource: 'applied',
            action: undefined
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.queryByText('Toggle fast mode')).toBeNull()
    const onRadio = screen.getByRole('radio', { name: 'On' })
    expect(onRadio.getAttribute('data-state')).toBe('checked')
    expect(onRadio.getAttribute('aria-checked')).toBe('true')
    const fastGroup = onRadio.parentElement
    expect(fastGroup?.getAttribute('data-radio-value')).toBe('on')
    expect(fastGroup?.getAttribute('data-on-value-change')).toBe('1')
    screen.getByRole('radio', { name: 'Off' }).click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('fastMode', false))

    setOption.mockClear()
    rerender(
      <NativeChatSessionOptionPickers
        surface={liveSurface}
        snapshot={[
          model(),
          {
            id: 'thinking',
            label: 'Thinking',
            category: 'mode',
            kind: { type: 'boolean' },
            valueSource: 'unknown',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    // Unknown composed boolean: hint + radios present, nothing pre-selected.
    expect(screen.getByText('Current value unknown — pick On or Off')).not.toBeNull()
    const thinkingGroup = screen.getByRole('radio', { name: 'On' }).parentElement
    expect(thinkingGroup?.getAttribute('data-radio-value')).toBe('')
    screen.getByRole('radio', { name: 'Off' }).click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('thinking', false))
  })

  it('does not show unconfirmed for applied flip-only booleans', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          {
            ...fast,
            kind: { type: 'boolean', currentValue: true },
            // Why: flip-only tracks as applied — never a healable dispatched state.
            valueSource: 'applied'
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.queryByText('Sent to the agent — not confirmed')).toBeNull()
  })

  it('shows unconfirmed for confirmable dispatched booleans', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          {
            id: 'thinking',
            label: 'Thinking',
            category: 'mode',
            kind: { type: 'boolean', currentValue: true },
            valueSource: 'dispatched',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getByText('Sent to the agent — not confirmed')).not.toBeNull()
  })
})
