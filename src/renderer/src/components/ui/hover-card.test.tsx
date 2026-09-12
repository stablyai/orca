// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'

const OPEN_DELAY = 100
const CLOSE_DELAY = 120

let container: HTMLDivElement
let root: Root

function Card({ id }: { id: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={OPEN_DELAY} closeDelay={CLOSE_DELAY}>
      <HoverCardTrigger asChild>
        <span data-trigger={id}>{id}</span>
      </HoverCardTrigger>
      <HoverCardContent data-content={id}>
        <button type="button">action {id}</button>
      </HoverCardContent>
    </HoverCard>
  )
}

function renderCards(ids: string[]): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <>
        {ids.map((id) => (
          <Card key={id} id={id} />
        ))}
      </>
    )
  })
}

function openCards(): string[] {
  return Array.from(document.querySelectorAll('[data-content]')).map(
    (node) => node.getAttribute('data-content') as string
  )
}
function trigger(id: string): HTMLElement {
  return container.querySelector(`[data-trigger="${id}"]`) as HTMLElement
}
function content(id: string): HTMLElement {
  return document.querySelector(`[data-content="${id}"]`) as HTMLElement
}

// React synthesizes pointerenter/pointerleave from native pointerover/pointerout.
function pointerOver(el: Element, from: Element | null, pointerType = 'mouse'): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        cancelable: true,
        relatedTarget: from,
        pointerType
      })
    )
  })
}
function pointerOut(el: Element, to: Element | null, pointerType = 'mouse'): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent('pointerout', {
        bubbles: true,
        cancelable: true,
        relatedTarget: to,
        pointerType
      })
    )
  })
}
function pointerMoveOver(el: Element, pointerType = 'mouse'): void {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType }))
  })
}
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('HoverCardContent stuck-open guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.useRealTimers()
  })

  it('closes a card the pointer transited when no content pointerout arrives', () => {
    renderCards(['A', 'B'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)
    expect(openCards()).toEqual(['A'])

    // Pointer crosses A's portaled content on its way to B. A fast transit can
    // leave Radix without the content pointerout that reschedules the close.
    pointerOut(trigger('A'), content('A'))
    pointerOver(content('A'), trigger('A'))
    pointerMoveOver(content('A'))
    advance(20)

    pointerMoveOver(trigger('B'))
    pointerOver(trigger('B'), content('A'))
    advance(OPEN_DELAY + CLOSE_DELAY + 100)

    expect(openCards()).toEqual(['B'])
  })

  it('dismisses on the single pointermove that carries the pointer to rest elsewhere', () => {
    renderCards(['A'])
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)

    pointerOut(trigger('A'), content('A'))
    pointerOver(content('A'), trigger('A'))
    pointerMoveOver(content('A'))
    advance(20)

    // Reaching any resting place requires at least one pointermove off the
    // card; the guard fires on that one rather than needing continuous motion.
    pointerMoveOver(elsewhere)
    advance(CLOSE_DELAY + 50)

    expect(openCards()).toEqual([])
    elsewhere.remove()
  })

  it('keeps the card open while the pointer moves from the trigger into the content', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)
    expect(openCards()).toEqual(['A'])

    pointerOut(trigger('A'), content('A'))
    pointerOver(content('A'), trigger('A'))
    // Moving around inside the card must never dismiss it — its buttons have to
    // stay clickable.
    pointerMoveOver(content('A'))
    advance(CLOSE_DELAY + OPEN_DELAY + 500)
    pointerMoveOver(content('A').querySelector('button') as Element)
    advance(500)

    expect(openCards()).toEqual(['A'])
  })

  it('keeps the card open while the pointer crosses the trigger-to-content gap', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)

    // sideOffset leaves a gap; pointermove lands on neither node before arrival
    pointerOut(trigger('A'), null)
    pointerMoveOver(document.body)
    advance(CLOSE_DELAY - 20)
    pointerOver(content('A'), null)
    pointerMoveOver(content('A'))
    advance(500)

    expect(openCards()).toEqual(['A'])
  })

  it('keeps the card open when the pointer returns to its own trigger', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)

    pointerOut(trigger('A'), content('A'))
    pointerOver(content('A'), trigger('A'))
    pointerMoveOver(content('A'))
    advance(20)

    // Assert the guard stays silent rather than only that the card survives:
    // React synthesizes a trigger pointerenter from any pointerout we dispatch
    // here, which re-opens the card and would mask a missing trigger check.
    const dismissals: Event[] = []
    content('A').addEventListener('pointerout', (event) => dismissals.push(event))

    pointerMoveOver(trigger('A'))
    advance(CLOSE_DELAY + 200)

    expect(dismissals).toEqual([])
    expect(openCards()).toEqual(['A'])
  })

  it('reopens after the pointer leaves and returns to the trigger', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)

    pointerOut(trigger('A'), document.body)
    advance(CLOSE_DELAY + 50)
    expect(openCards()).toEqual([])

    pointerOver(trigger('A'), document.body)
    advance(OPEN_DELAY + 50)
    expect(openCards()).toEqual(['A'])
  })

  it('opens from keyboard focus after the pointer has passed over the trigger', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)
    pointerOut(trigger('A'), document.body)
    advance(CLOSE_DELAY + 50)
    expect(openCards()).toEqual([])

    act(() => {
      trigger('A').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    advance(OPEN_DELAY + 50)

    expect(openCards()).toEqual(['A'])
  })

  it('ignores touch pointer moves so tap-held cards are not dismissed', () => {
    renderCards(['A'])
    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)

    pointerOut(trigger('A'), content('A'))
    pointerOver(content('A'), trigger('A'))
    pointerMoveOver(content('A'))
    advance(20)

    pointerMoveOver(document.body, 'touch')
    advance(CLOSE_DELAY + 200)

    expect(openCards()).toEqual(['A'])
  })

  it('removes its pointermove listener when the card closes', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    renderCards(['A'])

    pointerOver(trigger('A'), null)
    advance(OPEN_DELAY + 10)
    const added = addSpy.mock.calls.filter(([type]) => type === 'pointermove').length
    expect(added).toBeGreaterThan(0)

    pointerOut(trigger('A'), document.body)
    advance(CLOSE_DELAY + 50)

    const removed = removeSpy.mock.calls.filter(([type]) => type === 'pointermove').length
    expect(removed).toBe(added)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
