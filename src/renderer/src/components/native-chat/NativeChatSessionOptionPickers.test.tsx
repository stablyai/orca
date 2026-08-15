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

const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()
const mockStoreState = { openSettingsPage, openSettingsTarget }

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
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
  // Why: mirrors real Radix RadioGroup — context, not Children.map — so a
  // non-radio sibling (e.g. an unavailable-choice DropdownMenuItem) renders
  // as itself instead of being coerced into a radio button.
  const RadioGroupContext = React.createContext<{
    value?: string
    onValueChange?: (value: string) => void
  }>({})
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
    // Why: exposes the selected value + onValueChange wiring via
    // data-radio-value / data-on-value-change for assertions on the group.
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange
    }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (value: string) => void
    }) => {
      const contextValue = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange])
      return (
        <div
          role="radiogroup"
          data-radio-value={value ?? ''}
          data-on-value-change={onValueChange ? '1' : '0'}
        >
          <RadioGroupContext.Provider value={contextValue}>{children}</RadioGroupContext.Provider>
        </div>
      )
    },
    DropdownMenuRadioItem: ({
      children,
      disabled,
      value
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) => {
      const ctx = React.useContext(RadioGroupContext)
      const selected = value === ctx.value
      return (
        <button
          role="radio"
          aria-checked={selected}
          disabled={disabled}
          data-value={value}
          data-state={selected ? 'checked' : 'unchecked'}
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
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

const PERMISSION_MODE_CHOICES = [
  { value: 'manual', label: 'Manual' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  {
    value: 'bypassPermissions',
    label: 'Bypass permissions',
    unavailable: { action: 'open-agent-permissions-setting' as const }
  }
]

function permissionMode(overrides: Partial<SessionOptionDescriptor> = {}): SessionOptionDescriptor {
  return {
    id: 'permissionMode',
    label: 'Mode',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: 'manual',
      choices: PERMISSION_MODE_CHOICES
    },
    valueSource: 'applied',
    settable: true,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  openSettingsPage.mockClear()
  openSettingsTarget.mockClear()
})

describe('NativeChatSessionOptionPickers', () => {
  it('prefers collision-aware upward placement for model and option menus', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )

    const menus = screen.getAllByTestId('session-option-menu')
    expect(menus).toHaveLength(2)
    for (const menu of menus) {
      expect(menu.getAttribute('data-side')).toBe('top')
      expect(menu.getAttribute('data-collision-padding')).toBe('8')
    }
  })

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

  it('renders an unavailable choice as an Enable action while its siblings stay live radios', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), permissionMode()]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Bypass permissions Enable' })).not.toBeNull()
    expect(screen.queryByRole('radio', { name: /Bypass permissions/ })).toBeNull()
    for (const name of ['Manual', 'Accept edits', 'Plan', 'Auto']) {
      const radio = screen.getByRole('radio', { name })
      expect(radio.hasAttribute('disabled')).toBe(false)
    }
  })

  it('activating Enable deep-links to the agent permissions setting', async () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), permissionMode()]}
        isWorking={false}
      />
    )
    screen.getByRole('button', { name: 'Bypass permissions Enable' }).click()
    await waitFor(() =>
      expect(openSettingsTarget).toHaveBeenCalledWith({
        pane: 'agents',
        repoId: null,
        sectionId: 'agent-permissions'
      })
    )
    expect(openSettingsPage).toHaveBeenCalled()
  })

  it('selecting a normal mode row calls setOption with the chosen value', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    const liveSurface = { ...surface, setOption }
    render(
      <NativeChatSessionOptionPickers
        surface={liveSurface}
        snapshot={[model(), permissionMode()]}
        isWorking={false}
      />
    )
    screen.getByRole('radio', { name: 'Plan' }).click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('permissionMode', 'plan'))
  })

  it('renders all five choices as radio items when the launch granted bypass', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          permissionMode({
            kind: {
              type: 'select',
              currentValue: 'manual',
              choices: [
                { value: 'manual', label: 'Manual' },
                { value: 'acceptEdits', label: 'Accept edits' },
                { value: 'plan', label: 'Plan' },
                { value: 'auto', label: 'Auto' },
                { value: 'bypassPermissions', label: 'Bypass permissions' }
              ]
            }
          })
        ]}
        isWorking={false}
      />
    )
    for (const name of ['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions']) {
      expect(screen.getByRole('radio', { name })).not.toBeNull()
    }
    expect(screen.queryByText('Enable')).toBeNull()
  })

  it('gives permission mode its own pill, separate from the options dropdown', () => {
    const plan = permissionMode({
      kind: { type: 'select', currentValue: 'plan', choices: PERMISSION_MODE_CHOICES }
    })
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort, plan]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Mode Plan' })).not.toBeNull()
    // Why: mode must not leak into the shared effort/options pill's label or menu.
    expect(screen.getByRole('button', { name: 'Effort High' }).textContent).not.toContain('Plan')
    expect(screen.queryByRole('radio', { name: 'Accept edits' })).not.toBeNull()
  })

  it('orders the pills mode, then options, then model', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort, permissionMode()]}
        isWorking={false}
      />
    )
    const modeButton = screen.getByRole('button', { name: 'Mode Manual' })
    const optionsButton = screen.getByRole('button', { name: 'Effort High' })
    const modelButton = screen.getByRole('button', { name: 'Model Opus 4.8' })
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING
    expect(modeButton.compareDocumentPosition(optionsButton) & FOLLOWING).not.toBe(0)
    expect(optionsButton.compareDocumentPosition(modelButton) & FOLLOWING).not.toBe(0)
  })

  it('shows Manual on the dedicated pill even though the shared pill would have stayed quiet', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), permissionMode()]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Mode Manual' })).not.toBeNull()
  })

  it('falls back to "Mode" when the current value is unknown', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), permissionMode({ valueSource: 'unknown' })]}
        isWorking={false}
      />
    )
    expect(screen.getByRole('button', { name: 'Mode' })).not.toBeNull()
  })

  it('renders no Mode pill for a non-Claude agent, leaving the other pills unaffected', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )
    expect(screen.queryByRole('button', { name: /^Mode(\s|$)/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Effort High' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Model Opus 4.8' })).not.toBeNull()
  })
})
