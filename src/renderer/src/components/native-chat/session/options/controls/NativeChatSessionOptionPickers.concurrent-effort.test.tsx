// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

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

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

// Keep both pending descriptors visible when an effort commit closes the popover.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

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

const pill = (name: string): HTMLElement => screen.getByRole('button', { name })

afterEach(() => cleanup())

describe('NativeChatSessionOptionPickers', () => {
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

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'Home' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Effort' }).getAttribute('aria-valuenow')).toBe('0')
    )
    expect(pill('Model Opus 4.8, Effort Low')).not.toBeNull()
    expect(held()).toEqual(['false', 'true'])
    screen.getByRole('option', { name: 'Sonnet 5' }).click()
    expect(setOption.mock.calls).toEqual([
      ['effort', 'low'],
      ['model', 'sonnet']
    ])
    await waitFor(() => expect(held()).toEqual(['true', 'true']))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Effort' }), { key: 'End' })
    expect(setOption).toHaveBeenCalledTimes(2)

    // The snapshot is the truth once the write settles; here it still says High.
    await act(async () => settleWrite())
    await waitFor(() => expect(held()).toEqual(['true', 'false']))
    expect(screen.getByRole('slider', { name: 'Effort' }).getAttribute('aria-valuenow')).toBe('1')
    await act(async () => settleModel())
    await waitFor(() => expect(held()).toEqual(['false', 'false']))
  })
})
