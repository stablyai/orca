// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotItemRow } from './BotItemRow'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function rowText(item: BotItem): string {
  const { container } = render(
    <BotItemRow
      item={item}
      stale={false}
      snoozing={{ snooze: () => {}, pick: () => {}, dialog: null }}
      unseen={false}
      selected={false}
      selecting={false}
      now={0}
      onSelect={() => {}}
      onAction={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  return container.querySelector('[data-bot-item-open]')?.textContent ?? ''
}

it('keeps a Needs you row to one line, its question in the row’s description', () => {
  const asking = makeTestBotItem(6, {
    title: 'Decide: paused mail',
    status: 'needs_you',
    question: { eventId: 'e2', text: 'Hold mail while paused?' }
  })

  expect(rowText(asking)).not.toContain('Hold mail while paused?')
  const open = document.querySelector('[data-bot-item-open]')
  const description = document.getElementById(open?.getAttribute('aria-describedby') ?? '')
  expect(description?.textContent).toBe('Hold mail while paused?')
})

function renderMenuRow(): { trigger: HTMLElement; menuOpen: () => boolean } {
  render(
    <BotItemRow
      item={makeTestBotItem(4, { title: 'Ship it' })}
      stale={false}
      snoozing={{ snooze: () => {}, pick: () => {}, dialog: null }}
      unseen={false}
      selected={false}
      selecting={false}
      now={0}
      onSelect={() => {}}
      onAction={() => {}}
    />,
    { wrapper: TooltipProvider }
  )
  // Row 0–300 × 0–28, ⋯ at its right edge, menu 4px below the ⋯ and aligned to its end.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.matches('[role="listitem"]')
      ? [0, 0, 300, 28]
      : this.matches('[role="menu"]')
        ? [110, 30, 290, 100]
        : [270, 2, 290, 26]
    const [left, top, right, bottom] = box
    return {
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({})
    }
  })
  return {
    trigger: screen.getByRole('button', { name: 'More' }),
    menuOpen: () => screen.queryByRole('menu') !== null
  }
}

function movePointer(x: number, y: number): void {
  act(() => {
    document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: x, clientY: y }))
  })
}

it('closes the ⋯ menu on pointer exit only when opened by pointer', () => {
  const { trigger, menuOpen } = renderMenuRow()
  act(() => {
    trigger.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
  })
  expect(menuOpen()).toBe(true)

  movePointer(280, 28)
  movePointer(150, 60)
  movePointer(20, 10)
  expect(menuOpen()).toBe(true)

  movePointer(150, 200)
  expect(menuOpen()).toBe(false)

  fireEvent.keyDown(trigger, { key: 'Enter' })
  expect(menuOpen()).toBe(true)

  movePointer(150, 200)
  expect(menuOpen()).toBe(true)
})
