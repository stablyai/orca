// @vitest-environment happy-dom

import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HoverCardContent } from '@/components/ui/hover-card'
import { ActivityThreadHoverCardRoot } from './activity-thread-hover-card-root'
import {
  _resetActivityHoverCardIntentForTest,
  ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS,
  ACTIVITY_HOVER_CARD_REST_MS,
  ACTIVITY_HOVER_CARD_WARM_REST_MS
} from './activity-thread-hover-card-intent'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Exercise the production root and Radix primitive without the store-backed card body.
function Row({
  id,
  openDelay = 200,
  enabled = true
}: {
  id: string
  openDelay?: number
  enabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <ActivityThreadHoverCardRoot
      open={open}
      onOpenChange={setOpen}
      openDelay={openDelay}
      closeDelay={120}
      enabled={enabled}
      trigger={
        <div data-testid={id} data-open={open ? 'true' : 'false'} tabIndex={0}>
          {id}
          <button type="button" data-activity-thread-control="">
            <svg aria-label="Row action" />
          </button>
        </div>
      }
    >
      <HoverCardContent data-testid={`card-${id}`}>card {id}</HoverCardContent>
    </ActivityThreadHoverCardRoot>
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

  it('uses the configured keyboard delay without showing pointer progress', () => {
    act(() => root.render(<Row id="a" openDelay={350} />))
    act(() => row('a').focus())
    advance(349)
    expect(isOpen('a')).toBe(false)
    expect(isResting('a')).toBe(false)
    advance(1)
    expect(isOpen('a')).toBe(true)
  })

  it.each(['blur', 'scroll', 'pointerdown'])(
    'cancels a pending keyboard preview on %s',
    (event) => {
      act(() => row('a').focus())
      advance(50)
      if (event === 'blur') {
        act(() => row('a').blur())
      } else if (event === 'scroll') {
        scroll(row('list'))
      } else {
        pointer('pointerdown', row('a'), 10, 10)
      }
      advance(ACTIVITY_HOVER_CARD_REST_MS)
      expect(isOpen('a')).toBe(false)
    }
  )

  it('keeps an open preview while traversing the card and row, until entering a control', () => {
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    const card = document.querySelector('[data-testid="card-a"]')
    if (!card) {
      throw new Error('missing card a')
    }

    pointer('pointerout', row('a'), 30, 10, card)
    pointer('pointerover', card, 30, 10, row('a'))
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)
    scroll(card)
    expect(isOpen('a')).toBe(true)

    enter('a', 10, 10, card)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)

    const icon = row('a').querySelector('svg')!
    pointer('pointerover', icon, 20, 10, row('a'))
    expect(isOpen('a')).toBe(false)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
  })

  it('reopens after returning from the card through a control before the old close timer fires', () => {
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    const card = document.querySelector('[data-testid="card-a"]')
    if (!card) {
      throw new Error('missing card a')
    }

    pointer('pointerout', row('a'), 30, 10, card)
    pointer('pointerover', card, 30, 10, row('a'))
    const icon = row('a').querySelector('svg')!
    pointer('pointerout', card, 20, 10, icon)
    pointer('pointerover', icon, 20, 10, card)
    expect(isOpen('a')).toBe(false)

    advance(50)
    pointer('pointerout', icon, 11, 10, row('a'))
    pointer('pointerover', row('a'), 11, 10, icon)
    pointer('pointermove', row('a'), 11, 10)
    advance(ACTIVITY_HOVER_CARD_WARM_REST_MS - 1)
    expect(isOpen('a')).toBe(false)
    advance(1)
    expect(isOpen('a')).toBe(true)
  })

  it('discards a pending preview when disabled, requiring fresh intent after re-enabling', () => {
    act(() => root.render(<Row id="a" />))
    act(() => row('a').focus())
    advance(50)
    act(() => root.render(<Row id="a" enabled={false} />))
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)

    pointer('pointermove', row('a'), 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isResting('a')).toBe(false)
    expect(isOpen('a')).toBe(false)

    act(() => root.render(<Row id="a" />))
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
    pointer('pointermove', row('a'), 11, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)
  })

  it('does not open over a control icon, and resumes previews over the row', () => {
    const icon = row('a').querySelector('svg')!
    pointer('pointerover', icon, 10, 10)
    pointer('pointermove', icon, 10, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS * 2)
    expect(isOpen('a')).toBe(false)
    expect(isResting('a')).toBe(false)

    pointer('pointermove', row('a'), 11, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)
  })

  it('cancels a pending preview and dismisses an open preview on entering controls', () => {
    const icon = row('a').querySelector('svg')!
    enter('a', 10, 10)
    advance(ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS)
    expect(isResting('a')).toBe(true)

    pointer('pointerover', icon, 20, 10, row('a'))
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isResting('a')).toBe(false)
    expect(isOpen('a')).toBe(false)

    pointer('pointermove', row('a'), 11, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(true)

    pointer('pointerover', icon, 20, 10, row('a'))
    expect(isOpen('a')).toBe(false)
    pointer('pointermove', icon, 21, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
  })

  it('does not open the preview when keyboard focus reaches a row control', () => {
    act(() => row('a').querySelector('button')!.focus())
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('a')).toBe(false)
  })

  it('cancels a pending keyboard preview when the pointer enters a control', () => {
    act(() => row('a').focus())
    advance(50)

    const icon = row('a').querySelector('svg')!
    pointer('pointerover', icon, 20, 10)
    pointer('pointermove', icon, 20, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)

    expect(isOpen('a')).toBe(false)
  })

  it('ignores scroll-induced movement from a control onto another row', () => {
    const icon = row('a').querySelector('svg')!
    pointer('pointerover', icon, 20, 10)
    pointer('pointermove', icon, 20, 10)

    scroll(row('list'))
    enter('b', 20, 10, icon)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('b')).toBe(false)
    expect(isResting('b')).toBe(false)

    pointer('pointermove', row('b'), 21, 10)
    advance(ACTIVITY_HOVER_CARD_REST_MS)
    expect(isOpen('b')).toBe(true)
  })
})
