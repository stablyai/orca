// @vitest-environment happy-dom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  _resetActivityHoverCardIntentForTest,
  ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS,
  ACTIVITY_HOVER_CARD_REST_MS,
  ACTIVITY_HOVER_CARD_WARM_REST_MS,
  useActivityThreadHoverCardIntent
} from './activity-thread-hover-card-intent'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Same wiring as ActivityThreadHoverCard, over the real Radix primitive, without the store-backed card body.
function Row({ id }: { id: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const intent = useActivityThreadHoverCardIntent({
    open,
    onOpenChange: setOpen
  })
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={200} closeDelay={120}>
      <HoverCardTrigger
        asChild
        data-hover-card-resting={intent.resting ? '' : undefined}
        {...intent.triggerHandlers}
      >
        <div data-testid={id} data-open={open ? 'true' : 'false'} tabIndex={0}>
          {id}
        </div>
      </HoverCardTrigger>
      <HoverCardContent>card {id}</HoverCardContent>
    </HoverCard>
  )
}

function List(): ReactElement {
  return (
    <div data-testid="list">
      <Row id="a" />
      <Row id="b" />
    </div>
  )
}

describe('useActivityThreadHoverCardIntent', () => {
  let container: HTMLDivElement
  let root: Root

  const row = (id: string): HTMLElement => {
    const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
    if (!el) {
      throw new Error(`missing row ${id}`)
    }
    return el
  }
  const isOpen = (id: string): boolean => row(id).getAttribute('data-open') === 'true'
  const isResting = (id: string): boolean => row(id).hasAttribute('data-hover-card-resting')

  const pointer = (
    type: string,
    target: Element,
    x: number,
    y: number,
    relatedTarget: Element | null = null
  ): void => {
    act(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerType: 'mouse',
          relatedTarget
        })
      )
    })
  }
  const enter = (id: string, x: number, y: number, from: Element | null = null): void => {
    if (from) {
      pointer('pointerout', from, x, y, row(id))
    }
    pointer('pointerover', row(id), x, y, from)
    pointer('pointermove', row(id), x, y)
  }
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }
  const scroll = (target: Element): void => {
    act(() => {
      target.dispatchEvent(new Event('scroll'))
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    _resetActivityHoverCardIntentForTest()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<List />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('opens only after the pointer rests, showing progress partway through', () => {
    enter('a', 10, 10)

    advance(ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS - 1)
    expect(isResting('a')).toBe(false)
    advance(1)
    expect(isResting('a')).toBe(true)

    advance(ACTIVITY_HOVER_CARD_REST_MS - ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS - 1)
    expect(isOpen('a')).toBe(false)
    advance(1)
    expect(isOpen('a')).toBe(true)
    expect(isResting('a')).toBe(false)
  })

  it('restarts the rest while the pointer keeps moving', () => {
    enter('a', 10, 10)
    advance(400)
    pointer('pointermove', row('a'), 11, 10)
    advance(400)
    expect(isOpen('a')).toBe(false)
    expect(isResting('a')).toBe(true)

    advance(ACTIVITY_HOVER_CARD_REST_MS - 400)
    expect(isOpen('a')).toBe(true)
  })

  it('ignores hover events from a row sliding under a still pointer', () => {
    enter('a', 10, 10)
    advance(100)
    // Scrolling moves row b under the same coordinates.
    enter('b', 10, 10, row('a'))

    advance(ACTIVITY_HOVER_CARD_REST_MS * 2)
    expect(isOpen('a')).toBe(false)
    expect(isOpen('b')).toBe(false)
    expect(isResting('b')).toBe(false)
  })

  it('cancels a pending rest and closes an open card when the list scrolls', () => {
    enter('a', 10, 10)
    advance(300)
    scroll(row('list'))
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
    expect(isResting('a')).toBe(false)

    pointer('pointermove', row('a'), 12, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)

    scroll(row('list'))
    expect(isOpen('a')).toBe(false)
  })

  it('stays open when an unrelated element scrolls', () => {
    const unrelated = document.createElement('div')
    document.body.appendChild(unrelated)
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)

    scroll(unrelated)
    expect(isOpen('a')).toBe(true)
  })

  it('switches rows on a short rest while a card is showing', () => {
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)

    enter('b', 10, 40, row('a'))
    advance(ACTIVITY_HOVER_CARD_WARM_REST_MS)
    expect(isOpen('b')).toBe(true)
    expect(isOpen('a')).toBe(false)
  })

  it('needs the full rest again after a scroll dismissed the card', () => {
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    scroll(row('list'))

    enter('b', 10, 40, row('a'))
    advance(ACTIVITY_HOVER_CARD_WARM_REST_MS)
    expect(isOpen('b')).toBe(false)
    advance(ACTIVITY_HOVER_CARD_REST_MS - ACTIVITY_HOVER_CARD_WARM_REST_MS)
    expect(isOpen('b')).toBe(true)
  })

  it('does not open for a pointer that clicks before resting', () => {
    enter('a', 10, 10)
    advance(200)
    pointer('pointerdown', row('a'), 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
  })

  it('still opens from keyboard focus', () => {
    act(() => row('a').focus())
    advance(200)
    expect(isOpen('a')).toBe(true)
  })
})
