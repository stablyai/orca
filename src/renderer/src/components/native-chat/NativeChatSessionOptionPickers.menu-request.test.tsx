// @vitest-environment happy-dom

// Against the real picker: a `/model` request opens it once with the search focused, and a period
// while the host still lists models neither opens it later nor reopens one the user closed.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

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
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'

function model(pending: boolean): SessionOptionDescriptor {
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
    transport: 'agent-session',
    settable: !pending,
    ...(pending ? { choicesPending: true as const } : {})
  }
}

const surface: SessionOptionsSurface = {
  getSnapshot: () => [],
  setOption: vi.fn(async () => ({ snapshot: [] })),
  invokeAction: vi.fn(async () => ({ snapshot: [] })),
  subscribe: () => () => {}
}

function view(pending: boolean, request: NativeChatOptionPickerRequest | null): React.JSX.Element {
  return (
    <TooltipProvider>
      <textarea data-testid="composer" />
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model(pending)]}
        isWorking={false}
        pickerRequest={request}
      />
    </TooltipProvider>
  )
}

const settle = (): Promise<void> =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

afterEach(() => cleanup())

describe('model picker requests while the host lists models', () => {
  it('spends a request made while pending without opening the picker once the list lands', async () => {
    const request = { id: 'model', sequence: 1 }
    const { rerender } = render(view(true, request))
    const composer = screen.getByTestId('composer')
    composer.focus()
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()

    rerender(view(false, request))
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(document.activeElement).toBe(composer)

    // A new request after the list landed still opens it.
    rerender(view(false, { id: 'model', sequence: 2 }))
    await settle()
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('does not reopen a picker the user closed when a pending period ends', async () => {
    const request = { id: 'model', sequence: 1 }
    const { rerender } = render(view(false, request))
    await settle()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()

    rerender(view(true, request))
    await settle()
    rerender(view(false, request))
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
