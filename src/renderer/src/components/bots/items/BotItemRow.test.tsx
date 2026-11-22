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
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse'
      })
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

const PANEL = new DOMRect(744, 0, 280, 768)
/** The card and the popper wrapper Radix places it by. */
const isCard = (node: HTMLElement): boolean =>
  node.dataset.slot === 'hover-card-content' ||
  node.hasAttribute('data-radix-popper-content-wrapper')
const CARD = { width: 256, height: 120 }

/** A Needs you row in a 280px side panel at the right of a 1024×768 window, its title at `rowTop`. */
function renderPanelRow(rowTop: number) {
  const initialQuestion = { eventId: 'e1', text: 'Merge the guide-only PR?' }
  const panelRow = (question: BotItem['question']) => (
    <div data-right-sidebar-panel="">
      <BotItemRow
        item={makeTestBotItem(836, {
          title: 'Host-aware worker placement',
          status: 'needs_you',
          question
        })}
        stale={false}
        snoozing={{ snooze: () => {}, pick: () => {}, dialog: null }}
        unseen={false}
        selected={false}
        selecting={false}
        now={0}
        onSelect={() => {}}
        onAction={() => {}}
      />
    </div>
  )
  const { rerender } = render(panelRow(initialQuestion), { wrapper: TooltipProvider })
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024)
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768)
  // The card's laid-out size, which happy-dom does not compute from its classes.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return isCard(this) ? CARD.width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return isCard(this) ? CARD.height : 0
  })
  const panel = document.querySelector<HTMLElement>('[data-right-sidebar-panel]')!
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(PANEL)
  // The title starts after the row's padding, status icon and checkbox.
  const row = new DOMRect(776, rowTop, 224, 20)
  const open = document.querySelector<HTMLElement>('[data-bot-item-open]')!
  vi.spyOn(open, 'getBoundingClientRect').mockReturnValue(row)
  return { open, row, setQuestion: (next: BotItem['question']) => rerender(panelRow(next)) }
}

async function hoverOpen(open: HTMLElement): Promise<void> {
  fireEvent.pointerEnter(open, { pointerType: 'mouse' })
  fireEvent.pointerMove(open, { pointerType: 'mouse' })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

const cardElement = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-slot="hover-card-content"]')

/** Where the card is placed: its wrapper's translate and its laid-out size. */
function cardBox(): DOMRect {
  const wrapper = cardElement()!.parentElement!
  const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(wrapper.style.transform) ?? []
  return new DOMRect(Number(x), Number(y), CARD.width, CARD.height)
}

const overlaps = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

it.each([
  ['top', 100],
  ['last', 740]
])('opens the %s row’s card left of the side panel, covering nothing in it', async (_, rowTop) => {
  vi.useFakeTimers()
  try {
    const { open, row } = renderPanelRow(rowTop)
    await hoverOpen(open)
    expect(cardElement()?.getAttribute('data-side')).toBe('left')
    const card = cardBox()
    // Off the panel, so off the hovered row, its status icon and the rows around it, with a gap.
    expect(card.right).toBeLessThanOrEqual(PANEL.left - 8)
    expect(overlaps(card, PANEL)).toBe(false)
    expect(overlaps(card, row)).toBe(false)
    // Top at the row's, shifted up only as far as the window's bottom needs.
    expect(card.top).toBe(Math.min(row.top, 768 - 8 - CARD.height))
  } finally {
    vi.useRealTimers()
  }
})

const pointerAt = (x: number, y: number): void => {
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }))
}

it.each(['elsewhere in the panel', 'outside the window'])(
  'keeps the card open across the gap until the pointer moves %s',
  async (destination) => {
    vi.useFakeTimers()
    try {
      const { open } = renderPanelRow(100)
      await hoverOpen(open)
      vi.spyOn(cardElement()!, 'getBoundingClientRect').mockReturnValue(cardBox())
      fireEvent.pointerLeave(open, {
        pointerType: 'mouse',
        clientX: 776,
        clientY: 110
      })
      pointerAt(760, 112)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      pointerAt(744, 130)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(cardElement()).not.toBeNull()
      if (destination === 'outside the window') {
        fireEvent.pointerLeave(document.documentElement, { relatedTarget: null })
      } else {
        act(() => pointerAt(790, 300))
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(cardElement()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  }
)

it('closes the card after its delay when the pointer leaves the row away from it', async () => {
  vi.useFakeTimers()
  try {
    const { open } = renderPanelRow(100)
    await hoverOpen(open)
    fireEvent.pointerLeave(open, {
      pointerType: 'mouse',
      clientX: 1000,
      clientY: 110
    })
    pointerAt(1010, 110)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(cardElement()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('dismisses an item preview on an outside press during the close delay', async () => {
  vi.useFakeTimers()
  try {
    const { open } = renderPanelRow(100)
    await hoverOpen(open)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    vi.spyOn(cardElement()!, 'getBoundingClientRect').mockReturnValue(cardBox())
    fireEvent.pointerLeave(open, { pointerType: 'mouse', clientX: 772, clientY: 110 })
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', clientX: 741, clientY: 110 })
    fireEvent.pointerUp(document.body)
    fireEvent.click(document.body)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(cardElement()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('waits for a new hover after a refresh clears and restores a question', async () => {
  vi.useFakeTimers()
  try {
    const { open, setQuestion } = renderPanelRow(100)
    await hoverOpen(open)
    expect(cardElement()).not.toBeNull()
    setQuestion(null)
    expect(cardElement()).toBeNull()
    setQuestion({ eventId: 'e2', text: 'Approve the updated guide?' })
    expect(cardElement()).toBeNull()
    await hoverOpen(document.querySelector<HTMLElement>('[data-bot-item-open]')!)
    expect(cardElement()?.textContent).toContain('Approve the updated guide?')
  } finally {
    vi.useRealTimers()
  }
})
