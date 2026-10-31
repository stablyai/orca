// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-omp'
import type { AcpThinkingOptionsFixtureModule } from '../../../../shared/acp-thinking-options.test-fixture-contract'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

let recordedOmpOptions: AcpThinkingOptionsFixtureModule['recordedOmpOptions']
beforeAll(async () => {
  const fixtures = await vi.importActual<AcpThinkingOptionsFixtureModule>(
    '../../../../main/acp/acp-thinking-options.test-fixture'
  )
  recordedOmpOptions = fixtures.recordedOmpOptions
})

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))

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

// Keep mocked rows mounted for assertions; focus-return tests exercise real dismissal and focus.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="picker-root" data-open={open ? 'true' : 'false'}>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <div data-disabled={disabled || undefined}>{children}</div>
  ),
  PopoverContent: ({
    children,
    side,
    align,
    collisionPadding
  }: {
    children: React.ReactNode
    side?: string
    align?: string
    collisionPadding?: number
  }) => (
    <div
      data-testid="picker-content"
      data-side={side}
      data-align={align}
      data-collision-padding={collisionPadding}
    >
      {children}
    </div>
  )
}))

import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'

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

/** Only selects can truthfully have no current value; booleans require a baseline. */
const unknownEffort: SessionOptionDescriptor = {
  ...effort,
  kind: { type: 'select', choices: EFFORT_CHOICES },
  valueSource: 'unknown'
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

const settle = (): Promise<void> => act(async () => {})

const pill = (name: string): HTMLElement => screen.getByRole('button', { name })

const isOpen = (trigger: HTMLElement): boolean =>
  trigger.closest('[data-testid="picker-root"]')?.getAttribute('data-open') === 'true'

const effortLevels = (): HTMLElement[] =>
  within(screen.getByRole('radiogroup', { name: 'Effort' })).getAllByRole('radio')

afterEach(() => cleanup())

describe('NativeChatSessionOptionPickers', () => {
  it.each(['model', 'effort'])(
    'opens the one picker when a slash command asks for the %s',
    async (id) => {
      const demandModelCatalog = vi.fn()
      const demanding = { ...surface, demandModelCatalog }
      const { rerender } = render(
        <NativeChatSessionOptionPickers
          surface={demanding}
          snapshot={[model(), effort]}
          isWorking={false}
          pickerRequest={null}
        />
      )
      expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(false)
      expect(demandModelCatalog).not.toHaveBeenCalled()

      rerender(
        <NativeChatSessionOptionPickers
          surface={demanding}
          snapshot={[model(), effort]}
          isWorking={false}
          pickerRequest={{ id, consume: () => {} }}
        />
      )
      await waitFor(() => expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(true))
      expect(demandModelCatalog).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the picker a slash command opened when the next model lacks that option', () => {
    const request = { id: 'effort', consume: () => {} }
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort]}
        isWorking={false}
        pickerRequest={request}
      />
    )
    expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(true)

    rerender(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model()]}
        isWorking={false}
        pickerRequest={request}
      />
    )
    expect(isOpen(pill('Model Opus 4.8'))).toBe(true)
    expect(effortLevels().every((level) => level.hasAttribute('disabled'))).toBe(true)
  })

  // Consume session-held requests even across composer remounts so prompts cannot reopen the picker.
  it.each<[string, { composerShown?: boolean; snapshot?: SessionOptionDescriptor[] }]>([
    ['the composer comes back after a prompt card', { composerShown: false }],
    ['the session reports its model again', { snapshot: [] }]
  ])('opens once for a request, not again when %s', async (_case, gone) => {
    function Session(props: {
      composerShown?: boolean
      snapshot?: SessionOptionDescriptor[]
    }): React.JSX.Element | null {
      const [request, setRequest] = useState<NativeChatOptionPickerRequest | null>({
        id: 'model',
        consume: () => setRequest(null)
      })
      return props.composerShown === false ? null : (
        <NativeChatSessionOptionPickers
          surface={surface}
          snapshot={props.snapshot ?? [model(), effort]}
          isWorking={false}
          pickerRequest={request}
        />
      )
    }
    const { rerender } = render(<Session />)
    await waitFor(() => expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(true))

    rerender(<Session {...gone} />)
    expect(screen.queryByRole('button', { name: /^Model/ })).toBeNull()
    rerender(<Session />)
    expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(false)
  })

  it('sends a picked model to the session surface', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model()]}
        isWorking={false}
      />
    )
    screen.getByRole('option', { name: 'Sonnet 5' }).click()
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('model', 'sonnet'))
  })

  it('opens one picker upwards from the pill, anchored at its right edge', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )

    const content = screen.getByTestId('picker-content')
    expect(content.getAttribute('data-side')).toBe('top')
    expect(content.getAttribute('data-align')).toBe('end')
    expect(content.getAttribute('data-collision-padding')).toBe('8')
  })

  it('shows the model and its option values in one pill', () => {
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort, fast]}
        isWorking={false}
      />
    )
    expect(pill('Model Opus 4.8, Effort High · Fast').textContent).toBe('Opus 4.8High · Fast')

    rerender(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), unknownEffort]}
        isWorking={false}
      />
    )
    expect(pill('Model Opus 4.8').textContent).toBe('Opus 4.8')

    rerender(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), fast]}
        isWorking={false}
      />
    )
    expect(pill('Model Opus 4.8, Session options Fast').textContent).toBe('Opus 4.8Fast')
  })

  it('keeps terminal command pickers disabled while the agent is working', () => {
    render(
      <NativeChatSessionOptionPickers surface={surface} snapshot={[model(), effort]} isWorking />
    )
    expect(pill('Model Opus 4.8, Effort High').parentElement?.getAttribute('data-disabled')).toBe(
      'true'
    )
  })

  it('renders a session with no reported model without an empty model control', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('omp'),
      OMP_SESSION_OPTION_CATALOG,
      { models: [], current: { effort: 'off', confirmed: ['effort'] } }
    )
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={structuredAgentSessionOptionSnapshot(state)}
        isWorking={false}
      />
    )
    expect(screen.queryByRole('button', { name: /^Model/ })).toBeNull()
    expect(screen.queryAllByRole('button', { name: '' })).toEqual([])
  })

  it('names the control once when the model is unknown', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model({ kind: { type: 'select', choices: [] }, valueSource: 'unknown' })]}
        isWorking={false}
      />
    )
    expect(pill('Model').textContent).toBe('Model')
  })

  // Terminal dispatch lacks confirmation; structured per-turn reporting makes the same hedge unnecessary.
  it('hedges a dispatched value the terminal transport produced', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model({ valueSource: 'dispatched', transport: 'catalog' })]}
        isWorking={false}
      />
    )
    expect(screen.getAllByText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  it('does not hedge a dispatched value the structured transport produced', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model({ valueSource: 'dispatched', transport: 'agent-session' })]}
        isWorking={false}
      />
    )
    expect(screen.queryByText(/not confirmed/)).toBeNull()
  })

  it.each(['catalog'] as const)(
    'does not hedge a reported value on the %s transport',
    (transport) => {
      render(
        <NativeChatSessionOptionPickers
          surface={surface}
          snapshot={[model({ valueSource: 'reported', transport })]}
          isWorking={false}
        />
      )
      expect(screen.queryByText(/not confirmed/)).toBeNull()
    }
  )

  it('hedges the pill for a dispatched option as it does for the model', () => {
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
            transport: 'catalog',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.getAllByText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  it('renders agent-picker routes as one action instead of model rows', async () => {
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

  it.each([
    [
      "the table's words for a host's refusal, not its message",
      new RuntimeRpcCallError({
        id: 'request-1',
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'agent_session_journal_unreadable',
          data: {
            refusal: {
              code: 'agent_session_journal_unreadable',
              details: { reason: 'journalCorrupt' }
            }
          }
        },
        _meta: { runtimeId: 'runtime-1' }
      }),
      "Unable to load this chat. The setting wasn't changed."
    ],
    [
      "a local surface's own sentence",
      new Error('The terminal did not accept the command.'),
      'The terminal did not accept the command.'
    ]
  ])('describes a failed option change with %s', async (_label, error, description) => {
    toastError.mockClear()
    const invokeAction = vi.fn().mockRejectedValue(error)
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, invokeAction }}
        snapshot={[
          model({
            kind: { type: 'select', choices: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
            valueSource: 'unknown',
            action: { type: 'agent-picker' }
          })
        ]}
        isWorking={false}
      />
    )
    screen.getByRole('button', { name: 'Choose in agent picker…' }).click()
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledExactlyOnceWith('Could not update option', {
        description
      })
    )
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
            kind: { type: 'boolean', currentValue: false },
            valueSource: 'unknown',
            action: { type: 'toggle-command' }
          }
        ]}
        isWorking={false}
      />
    )
    // Flip-only without a baseline: an action, never a switch claiming On or Off.
    expect(screen.queryByRole('switch')).toBeNull()
    screen.getByRole('button', { name: 'Toggle fast mode' }).click()
    await waitFor(() => expect(invokeAction).toHaveBeenCalledWith('fastMode'))
    expect(setOption).not.toHaveBeenCalled()
  })

  it('uses one switch row for a boolean option without inventing a selection', async () => {
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
    expect(screen.queryByRole('radio')).toBeNull()
    const fastSwitch = screen.getByRole('switch', { name: 'Fast mode' })
    expect(fastSwitch.getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByText('Fast mode')).toHaveLength(1)
    fastSwitch.click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('fastMode', false))
    await settle()

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
            // Model the producer’s catalog fallback with unconfirmed provenance.
            kind: { type: 'boolean', currentValue: true },
            valueSource: 'unknown',
            transport: 'catalog',
            settable: true
          }
        ]}
        isWorking={false}
      />
    )
    expect(screen.queryByText('Current value unknown')).toBeNull()
    const thinkingSwitch = screen.getByRole('switch', { name: 'Thinking' })
    expect(thinkingSwitch.getAttribute('aria-checked')).toBe('true')
    thinkingSwitch.click()
    await waitFor(() => expect(setOption).toHaveBeenCalledWith('thinking', false))
  })

  it.each([
    { valueSource: 'unknown', transport: 'agent-session' },
    { valueSource: 'default', transport: 'catalog' },
    { valueSource: 'reported', transport: 'agent-session' }
  ] as const)('shows a $valueSource boolean as its switch alone', ({ valueSource, transport }) => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          { ...fast, kind: { type: 'boolean', currentValue: false }, valueSource, transport }
        ]}
        isWorking={false}
      />
    )
    const control = screen.getByRole('switch', { name: 'Fast mode' })
    expect(control.hasAttribute('aria-describedby')).toBe(false)
    expect(screen.queryByText('Not reported')).toBeNull()
    expect(screen.queryByText('Default')).toBeNull()
  })

  it.each(['new', 'loaded'] as const)(
    'offers recorded OMP thinking choices for a non-running model in a %s chat without picking a default',
    async (origin) => {
      const projected = recordedOmpOptions(origin).read()
      expect(projected.models[1]).toMatchObject({ effortsKnown: false })
      expect(projected.models[1]).not.toHaveProperty('defaultEffort')
      const state = applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('omp'),
        OMP_SESSION_OPTION_CATALOG,
        { origin: 'probe', fetchedAt: 1, models: projected.models },
        { newLaunch: origin === 'new' }
      )
      const view = structuredAgentSessionOptionView(state, undefined, { model: 'target' })
      const snapshot = structuredAgentSessionOptionSnapshot(view)
      expect(snapshot.find((entry) => entry.id === 'effort')).toMatchObject({
        valueSource: 'unknown',
        settable: true,
        kind: {
          type: 'select',
          choices: [
            { value: 'off', label: 'Off' },
            expect.objectContaining({ value: 'auto', label: 'Auto' })
          ]
        }
      })
      expect(snapshot.find((entry) => entry.id === 'effort')?.kind).not.toHaveProperty(
        'currentValue'
      )
      expect(view.record.values.effort).toBeUndefined()
      expect(structuredAgentSessionOptionPicks(view, { model: 'target' })).toEqual([
        { modelId: 'target', optionId: 'model', value: 'target' }
      ])
      const remembered = structuredAgentSessionOptionView(state, undefined, {
        model: 'target',
        effort: 'high'
      })
      expect(canSetStructuredAgentSessionOption(remembered, 'effort', 'high')).toBe(true)

      const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
      render(
        <NativeChatSessionOptionPickers
          surface={{ ...surface, setOption }}
          snapshot={snapshot}
          isWorking={false}
        />
      )
      fireEvent.click(pill('Model Target'))
      expect(setOption).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('radio', { name: 'Auto' }))
      await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'auto'))
    }
  )

  it('makes the effort levels one tab stop, moves between them with the arrow keys, and sends the one picked', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )
    const [low, high] = effortLevels()
    expect([low?.textContent, high?.textContent]).toEqual(['Low', 'High'])
    expect([low?.getAttribute('aria-checked'), high?.getAttribute('aria-checked')]).toEqual([
      'false',
      'true'
    ])
    // Tab stops at the group, not at each level, and lands on the level in use.
    expect(effortLevels().map((level) => level.tabIndex)).toEqual([-1, -1])
    screen.getByRole('radiogroup', { name: 'Effort' }).focus()
    await waitFor(() => expect(document.activeElement).toBe(high))

    // An arrow key moves focus without writing: each write is a round trip to the agent.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement).toBe(low))
    high?.click()
    expect(setOption).not.toHaveBeenCalled()

    low?.click()
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'low'))
  })

  // Voice control targets what is on screen (WCAG 2.5.3), so the name is the visible text.
  it('names a level by what it shows and describes it with the rest', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          {
            ...effort,
            kind: {
              type: 'select',
              currentValue: 'medium',
              choices: [
                { value: 'low', label: 'Low', description: 'Quick answers' },
                { value: 'medium', label: 'Medium' },
                { value: 'xhigh', label: 'Extra high', description: 'Deepest reasoning' },
                { value: 'max', label: 'Max' }
              ]
            }
          }
        ]}
        isWorking={false}
      />
    )
    const described = (name: string): string | null | undefined => {
      const id = screen.getByRole('radio', { name }).getAttribute('aria-describedby')
      return id ? document.getElementById(id)?.textContent : null
    }
    expect(described('Low')).toBe('Quick answers')
    expect(described('Med')).toBe('Medium')
    expect(described('XHigh')).toBe('Extra high Deepest reasoning')
    expect(described('Max')).toBeNull()
    expect(pill('Model Opus 4.8, Effort Med')?.textContent).toBe('Opus 4.8Med')
  })

  it('shows concurrent model and effort picks and releases only the settled descriptor', async () => {
    let settleWrite: () => void = () => {}
    let settleModel: () => void = () => {}
    const setOption = vi.fn(
      (id: string) =>
        new Promise<{ snapshot: SessionOptionDescriptor[] }>((resolve) => {
          if (id === 'model') {
            settleModel = () => resolve({ snapshot: [] })
          } else {
            settleWrite = () => resolve({ snapshot: [] })
          }
        })
    )
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )
    const held = (): (string | null | undefined)[] => [
      screen.getByRole('listbox').getAttribute('aria-busy'),
      screen
        .getByRole('radiogroup', { name: 'Effort' })
        .closest('[data-busy]')
        ?.getAttribute('aria-disabled')
    ]
    expect(held()).toEqual(['false', 'false'])

    screen.getByRole('radio', { name: 'Low' }).click()
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Low' }).getAttribute('aria-checked')).toBe('true')
    )
    expect(pill('Model Opus 4.8, Effort Low')).not.toBeNull()
    expect(held()).toEqual(['false', 'true'])
    screen.getByRole('option', { name: 'Sonnet 5' }).click()
    expect(setOption.mock.calls).toEqual([
      ['effort', 'low'],
      ['model', 'sonnet']
    ])
    await waitFor(() => expect(held()).toEqual(['true', 'true']))
    screen.getByRole('radio', { name: 'High' }).click()
    expect(setOption).toHaveBeenCalledTimes(2)

    // The snapshot is the truth once the write settles; here it still says High.
    await act(async () => settleWrite())
    await waitFor(() => expect(held()).toEqual(['true', 'false']))
    expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
    await act(async () => settleModel())
    await waitFor(() => expect(held()).toEqual(['false', 'false']))
  })

  it('keeps the model action usable while another descriptor saves', async () => {
    let settleWrite: () => void = () => {}
    const setOption = vi.fn(
      () =>
        new Promise<{ snapshot: SessionOptionDescriptor[] }>((resolve) => {
          settleWrite = () => resolve({ snapshot: [] })
        })
    )
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption, invokeAction }}
        snapshot={[
          model({ valueSource: 'unknown', action: { type: 'agent-picker' } }),
          { ...fast, kind: { type: 'boolean', currentValue: false } }
        ]}
        isWorking={false}
        pickerRequest={{ id: 'model', consume: () => {} }}
      />
    )
    const trigger = pill('Model')
    const action = screen.getByRole('button', { name: 'Choose in agent picker…' })
    const unavailable = (): string | null | undefined =>
      action.closest('[data-busy]')?.getAttribute('aria-disabled')
    expect(unavailable()).toBe('false')

    screen.getByRole('switch', { name: 'Fast mode' }).click()
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Fast mode' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    )
    expect(unavailable()).toBe('false')
    fireEvent.click(action)
    await act(async () => settleWrite())
    await waitFor(() => expect(invokeAction).toHaveBeenCalledExactlyOnceWith('model'))
    expect(isOpen(trigger)).toBe(false)
  })

  // The popover hangs from its bottom edge: a row that vanished would slide the list.
  it('keeps a row the next model lacks, switched off, while the picker is mounted', () => {
    const { rerender } = render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(), effort, fast]}
        isWorking={false}
      />
    )
    rerender(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model({
            kind: {
              type: 'select',
              currentValue: 'sonnet',
              choices: [
                { value: 'opus', label: 'Opus 4.8' },
                { value: 'sonnet', label: 'Sonnet 5' }
              ]
            }
          })
        ]}
        isWorking={false}
      />
    )
    const fastSwitch = screen.getByRole('switch', { name: 'Fast mode' })
    expect(fastSwitch).toHaveProperty('disabled', true)
    expect(fastSwitch.getAttribute('aria-checked')).toBe('false')
    expect(effortLevels().map((level) => level.getAttribute('aria-checked'))).toEqual([
      'false',
      'false'
    ])
    expect(effortLevels().every((level) => level.hasAttribute('disabled'))).toBe(true)
  })
})
