// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'

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

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await vi.importActual<typeof ReactModule>('react')
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({
      children,
      disabled
    }: {
      children: React.ReactNode
      disabled?: boolean
    }) => <div data-disabled={disabled || undefined}>{children}</div>,
    DropdownMenuContent: ({
      children,
      side,
      collisionPadding
    }: {
      children: React.ReactNode
      side?: string
      collisionPadding?: number
    }) => (
      <div
        data-testid="session-option-menu"
        data-side={side}
        data-collision-padding={collisionPadding}
      >
        {children}
      </div>
    ),
    DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="session-option-row">{children}</div>
    ),
    DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuSeparator: () => <hr />,
    // Forwards role/aria-* and hands onSelect an event: the switch rows set both,
    // and preventDefault is how a toggle keeps the menu open.
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
      ...rest
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      onSelect?: (event: { preventDefault: () => void }) => void
    }) => (
      <button
        {...rest}
        disabled={disabled}
        onClick={() => onSelect?.({ preventDefault: () => {} })}
      >
        {children}
      </button>
    ),
    // Why: exercises value binding + onValueChange contract the real Radix
    // group provides; selected value is exposed via data-radio-value.
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
      'aria-label': ariaLabel
    }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (value: string) => void
      'aria-label'?: string
    }) => (
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        data-radio-value={value ?? ''}
        data-on-value-change={onValueChange ? '1' : '0'}
      >
        {React.Children.map(children, (child) => {
          if (
            !React.isValidElement<{
              value?: string
              disabled?: boolean
              children?: React.ReactNode
            }>(child)
          ) {
            return child
          }
          const props = child.props
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
      <span data-radio-item data-disabled={disabled || undefined} {...{ value }}>
        {children}
      </span>
    )
  }
})

import { AgentSessionControls } from './AgentSessionControls'

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
    transport: 'catalog',
    settable: true,
    ...overrides
  }
}

const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

const effort: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: { type: 'select', currentValue: 'high', choices: EFFORT_CHOICES },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

/** A select with nothing picked. Only a select can be in this shape: it renders
 *  "nothing selected" truthfully, which is why the boolean kind requires a value. */
const unknownEffort: SessionOptionDescriptor = {
  ...effort,
  kind: { type: 'select', choices: EFFORT_CHOICES },
  valueSource: 'unknown'
}

const contextWindow: SessionOptionDescriptor = {
  id: 'contextWindow',
  label: 'Context window',
  category: 'model_config',
  kind: {
    type: 'select',
    currentValue: '1m',
    choices: [
      { value: 'standard', label: 'Standard (200k)' },
      { value: '1m', label: '1M' }
    ]
  },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

const fast: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: true },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

afterEach(() => cleanup())

describe('AgentSessionControls', () => {
  it('keeps a matching session effort visible without inventing a picker or stale Fast mode', () => {
    const context = {
      ...EMPTY_AGENT_SESSION_CONTEXT,
      model: 'opus',
      effort: 'high',
      fastMode: true
    }
    const off = { ...fast, kind: { type: 'boolean' as const, currentValue: false } }
    const props = { surface, isWorking: false, context, fallbackOptionLabel: 'High · Fast' }
    const { rerender } = render(<AgentSessionControls {...props} snapshot={[model(), off]} />)
    expect(
      screen.getByRole('button', { name: 'Opus 4.8 High. Context unavailable' })
    ).not.toBeNull()
    expect(screen.queryByText('Effort')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'High' })).toBeNull()

    rerender(<AgentSessionControls {...props} snapshot={[model(), fast]} />)
    expect(
      screen.getByRole('button', { name: 'Opus 4.8 High · Fast. Context unavailable' })
    ).not.toBeNull()

    rerender(
      <AgentSessionControls
        {...props}
        snapshot={[
          model(),
          {
            ...effort,
            kind: { type: 'select', currentValue: 'low', choices: [{ value: 'low', label: 'Low' }] }
          },
          off
        ]}
      />
    )
    expect(screen.getByRole('button', { name: 'Opus 4.8 Low. Context unavailable' })).not.toBeNull()

    rerender(
      <AgentSessionControls
        {...props}
        snapshot={[
          model({ kind: { type: 'select', currentValue: 'other-model', choices: [] } }),
          off
        ]}
      />
    )
    expect(
      screen.getByRole('button', { name: 'other-model Options. Context unavailable' })
    ).not.toBeNull()
  })

  it('shows the provider description for an unavailable option', () => {
    const description = 'Claude reports Fast mode unavailable: extra_usage_disabled.'
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), { ...fast, settable: false, description }]}
        isWorking={false}
      />
    )
    expect(screen.getByText(description)).not.toBeNull()
    expect(screen.getByRole('switch', { name: 'Fast mode' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps a participant pill visible while its persisted session is unavailable', () => {
    render(
      <AgentSessionControls
        surface={null}
        snapshot={[]}
        isWorking={false}
        leading={<span>@codex</span>}
      />
    )

    expect(screen.getByRole('button', { name: 'Session. Context unavailable' })).not.toBeNull()
    expect(screen.getByText('@codex')).not.toBeNull()
  })

  it('uses persisted labels only until live session options arrive', () => {
    const { rerender } = render(
      <AgentSessionControls
        surface={null}
        snapshot={[]}
        isWorking={false}
        fallbackModelLabel="GPT-5.6 Sol"
        fallbackOptionLabel="High · Fast"
        leading={<span>@codex</span>}
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'GPT-5.6 Sol High · Fast. Context unavailable'
      })
    ).not.toBeNull()

    rerender(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), effort]}
        isWorking={false}
        fallbackModelLabel="GPT-5.6 Sol"
        fallbackOptionLabel="High · Fast"
        leading={<span>@codex</span>}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Opus 4.8 High. Context unavailable' })
    ).not.toBeNull()
  })

  it('prefers collision-aware upward placement', () => {
    render(
      <AgentSessionControls surface={surface} snapshot={[model(), effort]} isWorking={false} />
    )

    const menu = screen.getByTestId('session-option-menu')
    expect(menu.getAttribute('data-side')).toBe('top')
    expect(menu.getAttribute('data-collision-padding')).toBe('8')
  })

  it('renders one session control with model and option labels', () => {
    const { rerender } = render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), effort, fast]}
        isWorking={false}
      />
    )
    const trigger = screen.getByRole('button', {
      name: 'Opus 4.8 High · Fast. Context unavailable'
    })
    expect(trigger.textContent).toContain('Opus 4.8')
    expect(trigger.textContent).toContain('High · Fast')

    rerender(<AgentSessionControls surface={surface} snapshot={[model()]} isWorking={false} />)
    expect(
      screen.getByRole('button', { name: 'Opus 4.8. Context unavailable' }).textContent
    ).not.toContain('Effort')
  })

  it('shows the selected context window immediately and keeps its label intact', () => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), effort, contextWindow]}
        isWorking={false}
        context={{
          model: 'opus',
          usedTokens: 100_000,
          maxTokens: 200_000,
          remainingTokens: 100_000,
          usedPercent: 50,
          source: 'statusline',
          observedAt: 1,
          compaction: 'idle',
          compactionUpdatedAt: null
        }}
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'Opus 4.8 High · 1M. 10% used · 100.0k / 1.0M tokens · 900.0k free'
      })
    ).not.toBeNull()
    expect(screen.getByText('Context window')).not.toBeNull()
  })

  it('does not put an unknown effort value in the pill', () => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), unknownEffort]}
        isWorking={false}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Opus 4.8. Context unavailable' }).textContent
    ).not.toContain('Effort')
  })

  it('keeps session details inspectable while the agent is working', () => {
    render(<AgentSessionControls surface={surface} snapshot={[model(), effort]} isWorking />)
    expect(
      screen
        .getByRole('button', { name: 'Opus 4.8 High. Context unavailable' })
        .hasAttribute('disabled')
    ).toBe(false)
    expect(screen.getByRole('radio', { name: 'Opus 4.8' }).hasAttribute('disabled')).toBe(true)
  })

  it('does not duplicate titles for unknown values or misname generic controls', () => {
    const { rerender } = render(
      <AgentSessionControls
        surface={surface}
        snapshot={[
          model({
            kind: { type: 'select', choices: [] },
            valueSource: 'unknown'
          }),
          unknownEffort
        ]}
        isWorking={false}
      />
    )
    const unknownTrigger = screen.getByRole('button', { name: 'Model. Context unavailable' })
    expect(unknownTrigger.textContent).not.toContain('Model: Model')
    expect(unknownTrigger.textContent).not.toContain('Effort: Effort')

    rerender(
      <AgentSessionControls surface={surface} snapshot={[model(), fast]} isWorking={false} />
    )
    expect(
      screen.getByRole('button', { name: 'Opus 4.8 Fast. Context unavailable' }).textContent
    ).toContain('Fast')
  })

  // The terminal transport typed the value at the agent and has not read it back,
  // so the pill says so; the structured transport's own per-turn report is the
  // confirmation, which makes the same hedge transient noise there.
  it('hedges a dispatched value the terminal transport produced', () => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model({ valueSource: 'dispatched', transport: 'catalog' })]}
        isWorking={false}
      />
    )
    expect(screen.getByText('Model')).not.toBeNull()
    expect(screen.getAllByText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  it('does not hedge a dispatched value the structured transport produced', () => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model({ valueSource: 'dispatched', transport: 'agent-session' })]}
        isWorking={false}
      />
    )
    expect(screen.getByText('Model')).not.toBeNull()
    expect(screen.queryByText(/not confirmed/)).toBeNull()
  })

  it.each(['catalog', 'agent-session'] as const)(
    'does not hedge a reported value on the %s transport',
    (transport) => {
      render(
        <AgentSessionControls
          surface={surface}
          snapshot={[model({ valueSource: 'reported', transport })]}
          isWorking={false}
        />
      )
      expect(screen.getByText('Model')).not.toBeNull()
      expect(screen.queryByText(/not confirmed/)).toBeNull()
    }
  )

  it('renders agent-picker routes as one action instead of radio choices', async () => {
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, invokeAction }
    render(
      <AgentSessionControls
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
      <AgentSessionControls
        surface={liveSurface}
        snapshot={[
          model(),
          {
            ...fast,
            kind: { type: 'boolean', currentValue: false },
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

  it('uses one switch row for a boolean option without inventing a selection', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, setOption }
    const { rerender } = render(
      <AgentSessionControls
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
    // One control, not an On/Off pair, and the row carries the label itself.
    expect(screen.queryByRole('radio', { name: 'On' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'Off' })).toBeNull()
    const fastSwitch = screen.getByRole('switch', { name: 'Fast mode' })
    expect(fastSwitch.getAttribute('aria-checked')).toBe('true')
    expect(
      fastSwitch.querySelector('[data-slot="switch-indicator"]')?.getAttribute('data-state')
    ).toBe('checked')
    expect(fastSwitch.textContent).toContain('Fast mode')
    fastSwitch.click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('fastMode', false))

    setOption.mockClear()
    rerender(
      <AgentSessionControls
        surface={liveSurface}
        snapshot={[
          model(),
          {
            id: 'thinking',
            label: 'Thinking',
            category: 'mode',
            // What the producer now emits for an unreported `thinking`: the
            // catalog default, with provenance still saying nothing confirmed it.
            kind: { type: 'boolean', currentValue: true },
            valueSource: 'unknown',
            transport: 'catalog',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    // The producer resolves the value, so the row renders it instead of a caption
    // apologising for a switch that had already collapsed to off.
    expect(screen.queryByText('Current value unknown')).toBeNull()
    const thinkingSwitch = screen.getByRole('switch', { name: 'Thinking' })
    expect(thinkingSwitch.getAttribute('aria-checked')).toBe('true')
    thinkingSwitch.click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('thinking', false))
  })

  // Both arms: `default` and `unreported` make opposite claims, and only
  // `unreported` is reachable in the structured lane, so one arm proves nothing.
  it.each([
    {
      name: 'a live unreported boolean is never labelled a default',
      valueSource: 'unknown',
      transport: 'agent-session',
      shown: 'Not reported',
      hidden: 'Default'
    },
    {
      name: 'a draft catalog default says so',
      valueSource: 'default',
      transport: 'catalog',
      shown: 'Default',
      hidden: 'Not reported'
    }
  ] as const)('$name', ({ valueSource, transport, shown, hidden }) => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[
          model(),
          { ...fast, kind: { type: 'boolean', currentValue: false }, valueSource, transport }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getAllByText(shown).length).toBeGreaterThan(0)
    expect(screen.queryByText(hidden)).toBeNull()
    // The marker qualifies the value; it must not become part of the control's name.
    const control = screen.getByRole('switch', { name: 'Fast mode' })
    // ...but it must still reach assistive tech: hiding it would leave screen
    // reader users unable to tell a default from an unreported value at all.
    const describedBy = control.getAttribute('aria-describedby') ?? ''
    expect(describedBy).not.toBe('')
    expect(document.getElementById(describedBy)?.textContent).toBe(shown)
  })

  it('drops the marker once something has picked the value', () => {
    render(
      <AgentSessionControls
        surface={surface}
        snapshot={[model(), { ...fast, valueSource: 'reported' }]}
        isWorking={false}
      />
    )
    expect(screen.queryByText('Default')).toBeNull()
    expect(screen.queryByText('Not reported')).toBeNull()
  })

  it('does not show unconfirmed for applied flip-only booleans', () => {
    render(
      <AgentSessionControls
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
      <AgentSessionControls
        surface={surface}
        snapshot={[
          model(),
          {
            id: 'thinking',
            label: 'Thinking',
            category: 'mode',
            kind: { type: 'boolean', currentValue: true },
            valueSource: 'dispatched',
            transport: 'catalog',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getAllByText('Thinking').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  it('adds a custom model only after the session confirms it', async () => {
    const custom = model({
      kind: {
        type: 'select',
        currentValue: 'gpt-5.6-sol',
        choices: [{ value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }]
      }
    })
    const setOption = vi.fn().mockResolvedValue({ snapshot: [custom] })
    const addCustomModel = vi.fn()
    render(
      <AgentSessionControls
        surface={{ ...surface, setOption, addCustomModel }}
        snapshot={[model()]}
        isWorking={false}
      />
    )

    const input = screen.getByRole('textbox', { name: 'Custom model' })
    fireEvent.change(input, { target: { value: 'gpt-5.6-sol' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(setOption).toHaveBeenCalledWith('model', 'gpt-5.6-sol'))
    expect(addCustomModel).toHaveBeenCalledWith('gpt-5.6-sol')
  })
})
