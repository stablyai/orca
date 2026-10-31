// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
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
import { model, effort, unknownEffort, fast } from './native-chat-option-picker.test-fixture'

const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn(),
  invokeAction: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}

const settle = (): Promise<void> => act(async () => {})

const pill = (name: string): HTMLElement => screen.getByRole('button', { name })

const isOpen = (trigger: HTMLElement): boolean =>
  trigger.closest('[data-testid="picker-root"]')?.getAttribute('data-open') === 'true'

const effortSlider = (): HTMLElement => screen.getByRole('slider', { name: 'Effort' })
const pickEffort = (key = 'Home'): boolean => fireEvent.keyDown(effortSlider(), { key })

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
    expect(effortSlider().hasAttribute('data-disabled')).toBe(true)
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

  it('uses one slider tab stop and commits exact supported effort IDs with the keyboard', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )
    const slider = effortSlider()
    expect(slider.tabIndex).toBe(0)
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    slider.focus()
    pickEffort('ArrowLeft')
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'low'))
  })

  it('previews supported effort steps while dragging and writes once on release', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), effort]}
        isWorking={false}
        pickerRequest={{ id: 'effort', consume: () => {} }}
      />
    )
    const root = effortSlider().closest('[data-slot="slider"]')
    if (!(root instanceof HTMLElement)) {
      throw new Error('Missing effort slider root')
    }
    root.getBoundingClientRect = () => new DOMRect(0, 0, 100, 16)
    root.setPointerCapture = vi.fn()
    root.hasPointerCapture = () => true
    root.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(root, { pointerId: 1, clientX: 0, clientY: 8 })
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('Low')
    expect(setOption).not.toHaveBeenCalled()
    expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(true)
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 100, clientY: 8 })
    fireEvent.pointerMove(root, { pointerId: 1, clientX: 0, clientY: 8 })
    expect(setOption).not.toHaveBeenCalled()
    fireEvent.pointerUp(root, { pointerId: 1, clientX: 0, clientY: 8 })
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'low'))
    expect(isOpen(pill('Model Opus 4.8, Effort High'))).toBe(false)
  })

  it('shows a compact effort label and exposes its provider description as the slider value', () => {
    render(
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[
          model(),
          {
            ...effort,
            kind: {
              type: 'select',
              currentValue: 'xhigh',
              choices: [
                { value: 'low', label: 'Low', description: 'Quick answers' },
                { value: 'xhigh', label: 'Extra high', description: 'Deepest reasoning' },
                { value: 'max', label: 'Max' }
              ]
            }
          }
        ]}
        isWorking={false}
      />
    )
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('Extra high · Deepest reasoning')
    expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull()
    expect(pill('Model Opus 4.8, Effort XHigh').textContent).toBe('Opus 4.8XHigh')
  })

  it('keeps the current effort passive and adjusts it only through the slider', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), effort]}
        isWorking={false}
      />
    )
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    fireEvent.click(screen.getAllByText('High')[0]!)
    expect(setOption).not.toHaveBeenCalled()
    expect(effortSlider().tabIndex).toBe(0)
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('High')
    pickEffort('Home')
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'low'))
  })

  it('keeps an unlisted reported effort read-only through the actual snapshot pipeline', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        current: { model: 'account-model', effort: 'unsupported-level', confirmed: ['effort'] }
      }
    )
    const setOption = vi.fn()
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={structuredAgentSessionOptionSnapshot(state)}
        isWorking={false}
      />
    )
    expect(screen.queryByRole('slider', { name: 'Effort' })).toBeNull()
    expect(screen.queryByRole('radio', { name: 'unsupported-level' })).toBeNull()
    expect(screen.getAllByText('unsupported-level').length).toBeGreaterThan(0)
    expect(setOption).not.toHaveBeenCalled()
  })

  it('keeps an unknown effort unreported until a supported choice is committed', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render(
      <NativeChatSessionOptionPickers
        surface={{ ...surface, setOption }}
        snapshot={[model(), unknownEffort]}
        isWorking={false}
      />
    )
    const group = screen.getByRole('radiogroup', { name: 'Effort' })
    expect(screen.queryByRole('slider')).toBeNull()
    expect(
      within(group)
        .getAllByRole('radio')
        .every((radio) => radio.getAttribute('aria-checked') === 'false')
    ).toBe(true)
    expect(setOption).not.toHaveBeenCalled()
    fireEvent.click(within(group).getByRole('radio', { name: 'High' }))
    await waitFor(() => expect(setOption).toHaveBeenCalledExactlyOnceWith('effort', 'high'))
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
        .getByRole('slider', { name: 'Effort' })
        .closest('[data-busy]')
        ?.getAttribute('aria-disabled')
    ]
    expect(held()).toEqual(['false', 'false'])

    pickEffort()
    await waitFor(() => expect(effortSlider().getAttribute('aria-valuetext')).toBe('Low'))
    expect(pill('Model Opus 4.8, Effort Low')).not.toBeNull()
    expect(held()).toEqual(['false', 'true'])
    screen.getByRole('option', { name: 'Sonnet 5' }).click()
    expect(setOption.mock.calls).toEqual([
      ['effort', 'low'],
      ['model', 'sonnet']
    ])
    await waitFor(() => expect(held()).toEqual(['true', 'true']))
    pickEffort('End')
    expect(setOption).toHaveBeenCalledTimes(2)

    // The snapshot is the truth once the write settles; here it still says High.
    await act(async () => settleWrite())
    await waitFor(() => expect(held()).toEqual(['true', 'false']))
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('High')
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
    expect(effortSlider().getAttribute('aria-valuetext')).toBe('—')
    expect(effortSlider().hasAttribute('data-disabled')).toBe(true)
  })
})
