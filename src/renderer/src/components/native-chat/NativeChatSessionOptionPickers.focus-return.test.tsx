// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

const settle = (): Promise<void> =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn(() => Promise.resolve({ snapshot: [] })),
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

const fast: SessionOptionDescriptor = {
  id: 'fastMode',
  label: 'Fast mode',
  category: 'mode',
  kind: { type: 'boolean', currentValue: false },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

/** The pickers beside a real message box, so focus has somewhere to come back to. */
async function renderComposer(snapshot: SessionOptionDescriptor[]): Promise<HTMLElement> {
  const messageBox = document.createElement('textarea')
  render(
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={snapshot}
        isWorking={false}
        focusComposer={() => messageBox.focus()}
      />
    </TooltipProvider>
  )
  document.body.append(messageBox)
  await settle()
  return messageBox
}

/** The options pill opens a menu; the model pill opens the search popover. */
const pill = (surfaceKind: 'menu' | 'dialog'): HTMLElement => {
  const found = screen
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-haspopup') === surfaceKind)
  if (!found) {
    throw new Error(`no pill opening a ${surfaceKind}`)
  }
  return found
}

/** The menu opens on pointerdown, which happy-dom does not synthesize, so press Enter instead. */
const openPill = async (surfaceKind: 'menu' | 'dialog'): Promise<HTMLElement> => {
  const trigger = pill(surfaceKind)
  if (surfaceKind === 'menu') {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  } else {
    fireEvent.click(trigger)
  }
  await settle()
  return trigger
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('session option picker focus return', () => {
  it('lands focus in the message box after an effort choice', async () => {
    const messageBox = await renderComposer([model, effort])
    await openPill('menu')

    fireEvent.click(screen.getByRole('menuitemradio', { name: /High/ }))
    await settle()

    expect(surface.setOption).toHaveBeenCalledWith('effort', 'high')
    expect(document.activeElement).toBe(messageBox)
  })

  it('lands focus in the message box after a model choice', async () => {
    const messageBox = await renderComposer([model, effort])
    await openPill('dialog')

    fireEvent.click(screen.getByRole('option', { name: /Sonnet 5/ }))
    await settle()

    expect(surface.setOption).toHaveBeenCalledWith('model', 'sonnet')
    expect(document.activeElement).toBe(messageBox)
  })

  it('leaves focus on the pill when the picker is dismissed instead of used', async () => {
    await renderComposer([model, effort])
    const trigger = await openPill('menu')

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await settle()

    expect(surface.setOption).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps focus in the open menu when a toggle leaves it open', async () => {
    await renderComposer([model, effort, fast])
    await openPill('menu')

    fireEvent.click(screen.getByRole('switch', { name: 'Fast mode' }))
    await settle()

    expect(surface.setOption).toHaveBeenCalledWith('fastMode', true)
    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()
    expect(menu.contains(document.activeElement)).toBe(true)
  })
})
