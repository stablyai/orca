// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback
        )
      : fallback
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  SessionOptionDescriptor,
  SessionOptionSetResult,
  SessionOptionValue
} from '../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../../shared/structured-agent-session-option-view'

const settle = (): Promise<void> =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

it('keeps pointer, ArrowDown and requested-open on the same disabled-placeholder boundary', async () => {
  const placeholder: SessionOptionDescriptor = {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: { type: 'select', choices: [] },
    valueSource: 'unknown',
    transport: 'agent-session',
    settable: false
  }
  const consume = vi.fn()
  const view = render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[placeholder]}
        isWorking={false}
      />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Model' })
  expect(trigger).toHaveProperty('disabled', true)
  fireEvent.click(trigger)
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  view.rerender(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[placeholder]}
        isWorking={false}
        pickerRequest={{ id: 'model', consume }}
      />
    </TooltipProvider>
  )
  await settle()
  expect(consume).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[placeholder, effort]}
        isWorking={false}
      />
    </TooltipProvider>
  )
  expect(trigger).toHaveProperty('disabled', false)
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await settle()
  expect(screen.getByRole('dialog')).not.toBeNull()
})

const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn((_id: string, _value: SessionOptionValue): Promise<SessionOptionSetResult> =>
    Promise.resolve({ snapshot: [] })
  ),
  invokeAction: vi.fn(() => Promise.resolve({ snapshot: [] })),
  subscribe: vi.fn(() => vi.fn())
}

const model: SessionOptionDescriptor = {
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
  settable: true
}

const effort: SessionOptionDescriptor = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    currentValue: 'low',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

const speed: SessionOptionDescriptor = {
  id: 'serviceTier',
  label: 'Speed',
  category: 'mode',
  kind: {
    type: 'select',
    currentValue: 'default',
    choices: [
      { value: 'default', label: 'Standard' },
      { value: 'fast', label: 'Fast' }
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
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

async function renderComposer(
  snapshot: SessionOptionDescriptor[],
  pickerRequest: NativeChatOptionPickerRequest | null = null
): Promise<HTMLElement> {
  const messageBox = document.createElement('textarea')
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={snapshot}
        isWorking={false}
        pickerRequest={pickerRequest}
        focusComposer={() => messageBox.focus()}
      />
    </TooltipProvider>
  )
  document.body.append(messageBox)
  await settle()
  return messageBox
}

/** A slash command's request held by the session, which drops it when the picker consumes it. */
function Session(props: {
  requestId: string
  composerShown?: boolean
  surfaceShown?: boolean
}): React.JSX.Element {
  const [request, setRequest] = useState<NativeChatOptionPickerRequest | null>({
    id: props.requestId,
    consume: () => setRequest(null)
  })
  return (
    <TooltipProvider>
      {props.composerShown === false ? null : (
        <NativeChatSessionOptionPickers
          surface={props.surfaceShown === false ? null : surface}
          snapshot={[model, effort]}
          isWorking={false}
          pickerRequest={request}
        />
      )}
    </TooltipProvider>
  )
}

const pill = (): HTMLElement => screen.getByRole('button', { name: /^Model / })

const openPicker = async (): Promise<HTMLElement> => {
  const trigger = pill()
  fireEvent.click(trigger)
  await settle()
  return trigger
}

const pressEscape = async (): Promise<void> => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await settle()
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('session option picker focus', () => {
  it.each(['click', 'ArrowDown'] as const)('opens on %s with the search focused', async (how) => {
    await renderComposer([model, effort])
    const trigger = pill()
    if (how === 'click') {
      fireEvent.click(trigger)
    } else {
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    }
    await settle()

    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('opens on the option a slash command asked for, once', async () => {
    await renderComposer([model, effort], { id: 'effort', consume: () => {} })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Low' }))

    // The request is spent: opening by hand afterwards focuses the search as usual.
    await pressEscape()
    await openPicker()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('stays open across a model, a speed and a switch pick, and closes into the message box on an effort pick', async () => {
    const messageBox = await renderComposer([model, effort, speed, fast])
    await openPicker()

    fireEvent.click(screen.getByRole('option', { name: /Sonnet 5/ }))
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: 'Fast' }))
    await settle()
    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    await settle()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    await settle()

    expect(surface.setOption.mock.calls).toEqual([
      ['model', 'sonnet'],
      ['serviceTier', 'fast'],
      ['fastMode', true],
      ['effort', 'high']
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(messageBox)
  })

  it('captures an explicit click on the displayed Codex default while passive display stays sparse', async () => {
    let state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'gpt-host',
            label: 'GPT Host',
            isDefault: true,
            defaultEffort: 'low',
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        listedModelIds: ['gpt-host'],
        current: { model: 'gpt-host', acceptedInputSources: { model: 'saved' }, defaulted: [] }
      }
    )
    surface.setOption.mockImplementationOnce(async (id: string, value: SessionOptionValue) => {
      state = commitStructuredAgentSessionOption(state, id, String(value))
      return { snapshot: structuredAgentSessionShownSnapshot(state) }
    })
    await renderComposer(structuredAgentSessionShownSnapshot(state))
    expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: 'gpt-host' })
    await openPicker()
    fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
    await settle()
    expect(surface.setOption).toHaveBeenCalledExactlyOnceWith('effort', 'low')
    expect(structuredAgentSessionMessageSelection(state)).toEqual({
      model: 'gpt-host',
      effort: 'low'
    })
  })

  it('closes on a press of the effort level already in use, without a write', async () => {
    const messageBox = await renderComposer([model, effort])
    await openPicker()

    fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
    await settle()

    expect(surface.setOption).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(messageBox)
  })

  // A level the picked model lacks is removed, and a removed element takes focus with it.
  it('moves focus from an option to the search when a model row is pressed', async () => {
    await renderComposer([model, effort])
    await openPicker()
    screen.getByRole('radio', { name: 'High' }).focus()

    fireEvent.mouseDown(screen.getByRole('option', { name: /Sonnet 5/ }))

    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  // The tooltip is the top layer, so Radix gives it the first Escape; one press still closes both.
  it('closes on one Escape from a level whose tooltip is showing', async () => {
    const levels: SessionOptionDescriptor = {
      ...effort,
      kind: {
        type: 'select',
        currentValue: 'xhigh',
        choices: [
          { value: 'medium', label: 'Medium' },
          { value: 'xhigh', label: 'Extra high' }
        ]
      }
    }
    await renderComposer([model, levels])
    const trigger = await openPicker()
    const level = screen.getByRole('radio', { name: 'XHigh' })
    // The tooltip's own open/closed state must not replace the one the level is styled by.
    expect(level.getAttribute('data-state')).toBe('on')
    level.focus()
    await settle()
    expect(screen.getByRole('tooltip')).not.toBeNull()

    await pressEscape()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves focus on the pill when the picker is dismissed instead of used', async () => {
    await renderComposer([model, effort])
    const trigger = await openPicker()

    await pressEscape()

    expect(surface.setOption).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('lands focus in the message box when the pill closes the picker after a pick', async () => {
    const messageBox = await renderComposer([model, effort])
    const trigger = await openPicker()
    fireEvent.click(screen.getByRole('option', { name: /Sonnet 5/ }))
    await settle()

    // What a press is to the browser: pointerdown, focus on the button, then the click.
    fireEvent.pointerDown(trigger)
    trigger.focus()
    fireEvent.click(trigger)
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(messageBox)
  })

  it('leaves focus where a click outside put it, even after a pick', async () => {
    await renderComposer([model, effort])
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    await openPicker()
    fireEvent.click(screen.getByRole('option', { name: /Sonnet 5/ }))
    await settle()

    // Radix waits for the click that follows an outside pointerdown before it dismisses.
    fireEvent.pointerDown(elsewhere)
    elsewhere.focus()
    fireEvent.click(elsewhere)
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('opens once for a request, and comes back closed after the pill went away', async () => {
    const { rerender } = render(<Session requestId="model" />)
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeNull()

    rerender(<Session requestId="model" surfaceShown={false} />)
    await settle()
    expect(screen.queryByRole('button', { name: /^Model / })).toBeNull()
    rerender(<Session requestId="model" />)
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses the effort for /effort once, not again after a prompt card', async () => {
    const { rerender } = render(<Session requestId="effort" />)
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Low' }))

    rerender(<Session requestId="effort" composerShown={false} />)
    await settle()
    rerender(<Session requestId="effort" />)
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()

    await openPicker()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('shows a tooltip on the pill only for what the pill cannot show', async () => {
    await renderComposer([model, effort])
    fireEvent.pointerMove(pill(), { pointerType: 'mouse' })
    pill().focus()
    await settle()
    expect(screen.queryByRole('tooltip')).toBeNull()

    cleanup()
    await renderComposer([
      { ...model, settable: false, disabledReason: 'set-when-session-starts' },
      effort
    ])
    pill().focus()
    await settle()
    expect(screen.getByRole('tooltip').textContent).toBe('Set when the session starts.')
  })
})
