// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'

const MIN_TAB_WIDTH = 100
const BASIS_TAB_WIDTH = 180
const DEFAULT_VIEWPORT_WIDTH = 300

const scrollLeftByElement = new WeakMap<Element, number>()
const originals = {
  rect: HTMLElement.prototype.getBoundingClientRect,
  scrollIntoView: HTMLElement.prototype.scrollIntoView,
  scrollLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollLeft'),
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
}

function isStrip(el: Element): boolean {
  return el.hasAttribute('data-strip')
}

function rect(left: number, width: number): DOMRect {
  return DOMRect.fromRect({ x: left, y: 0, width, height: 20 })
}

/**
 * Flex layout of the real strip: tabs start at 180px and shrink to a 100px floor, a strip that
 * fits shrink-wraps its tabs, and an overflowing one fills the viewport and scrolls.
 */
function stripLayout(strip: Element): {
  tabWidth: number
  clientWidth: number
  scrollWidth: number
} {
  const slots = strip.querySelectorAll(':scope > [data-tab-strip-slot]').length
  const spacerEl = strip.querySelector<HTMLElement>(':scope > [data-close-spacer]')
  const spacer = spacerEl ? Number.parseFloat(spacerEl.style.width || '0') : 0
  const viewport = Number(strip.getAttribute('data-viewport') ?? DEFAULT_VIEWPORT_WIDTH)
  const basis = slots * BASIS_TAB_WIDTH + spacer
  if (basis <= viewport) {
    return { tabWidth: BASIS_TAB_WIDTH, clientWidth: basis, scrollWidth: basis }
  }
  const tabWidth = slots > 0 ? Math.max(MIN_TAB_WIDTH, (viewport - spacer) / slots) : 0
  return {
    tabWidth,
    clientWidth: viewport,
    scrollWidth: Math.max(viewport, slots * tabWidth + spacer)
  }
}

function maxScrollLeft(el: Element): number {
  const { clientWidth, scrollWidth } = stripLayout(el)
  return Math.max(0, scrollWidth - clientWidth)
}

/** A tab's x is its index times the tab width minus the scroll, clamped into view when docked. */
function installStripLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? stripLayout(this).scrollWidth : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? stripLayout(this).clientWidth : 0
    }
  })
  // Why clamp and keep: a browser clamps scrollLeft as soon as the content shrinks.
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      const value = Math.min(
        isStrip(this) ? maxScrollLeft(this) : 0,
        scrollLeftByElement.get(this) ?? 0
      )
      scrollLeftByElement.set(this, value)
      return value
    },
    set(this: Element, value: number) {
      const max = isStrip(this) ? maxScrollLeft(this) : 0
      scrollLeftByElement.set(this, Math.min(max, Math.max(0, value)))
    }
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (isStrip(this)) {
      return rect(0, stripLayout(this).clientWidth)
    }
    const strip = this.parentElement
    if (strip && isStrip(strip)) {
      const { tabWidth, clientWidth } = stripLayout(strip)
      const index = Array.from(strip.children).indexOf(this)
      const left = index * tabWidth - strip.scrollLeft
      const docked = this.hasAttribute('data-active-tab-dock')
      return rect(docked ? Math.min(clientWidth - tabWidth, Math.max(0, left)) : left, tabWidth)
    }
    return rect(0, 0)
  }
  HTMLElement.prototype.scrollIntoView = function (): void {}
}

function restoreStripLayout(): void {
  HTMLElement.prototype.getBoundingClientRect = originals.rect
  HTMLElement.prototype.scrollIntoView = originals.scrollIntoView
  for (const key of ['scrollLeft', 'scrollWidth', 'clientWidth'] as const) {
    const descriptor = originals[key]
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  }
}

const NO_HOSTED_ROWS: string[] = []

/** `hostedRows` render like client-hosted browser rows: a strip slot with no `data-tab-id`. */
function Strip({
  tabs,
  active,
  hostedRows = NO_HOSTED_ROWS,
  activeHostedRow = null,
  viewport
}: {
  tabs: string[]
  active: string
  hostedRows?: string[]
  activeHostedRow?: string | null
  viewport?: number
}): React.JSX.Element {
  const navigation = useTabStripOverflowNavigation({
    activeVisibleTabId: active,
    activeDockSlotId: activeHostedRow ?? active,
    layoutKey: [...tabs, ...hostedRows].join(','),
    worktreeId: 'wt-1'
  })
  return (
    <div
      data-strip=""
      data-viewport={viewport}
      data-dock={navigation.activeTabDockSide ?? undefined}
      ref={navigation.tabStripRef}
    >
      {tabs.map((id) => (
        <div
          key={id}
          data-tab-id={id}
          data-tab-strip-slot={id}
          data-active-tab-dock={id === active && !activeHostedRow ? '' : undefined}
        >
          <button type="button" data-tab-close-button="true" />
        </div>
      ))}
      {hostedRows.map((id) => (
        <div
          key={id}
          data-tab-strip-slot={id}
          data-active-tab-dock={id === activeHostedRow ? '' : undefined}
        >
          <button type="button" data-tab-close-button="true" />
        </div>
      ))}
      <div data-close-spacer="" ref={navigation.closeSpacerRef} />
    </div>
  )
}

const TABS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']

function mountScrolled(active: string, scrollLeft: number, hostedRows?: string[]) {
  const view = render(<Strip tabs={TABS} active={active} hostedRows={hostedRows} />)
  const strip = view.container.querySelector<HTMLElement>('[data-strip]')!
  act(() => {
    strip.scrollLeft = scrollLeft
    strip.dispatchEvent(new Event('scroll'))
  })
  return { ...view, strip }
}

function tabX(strip: HTMLElement, id: string): number {
  return strip.querySelector<HTMLElement>(`[data-tab-strip-slot="${id}"]`)!.getBoundingClientRect()
    .left
}

describe('tab strip scroll when tabs are added', () => {
  beforeEach(installStripLayout)
  afterEach(() => {
    cleanup()
    restoreStripLayout()
  })

  it('keeps the viewed tab still when a background tab lands on screen after it', () => {
    const { strip, rerender } = mountScrolled('F', 400)
    rerender(<Strip tabs={[...TABS.slice(0, 6), 'N', ...TABS.slice(6)]} active="F" />)
    expect(strip.scrollLeft).toBe(400)
    expect(tabX(strip, 'F')).toBe(100)
  })

  it('does not scroll for a background tab that opens on screen', () => {
    const { strip, rerender } = mountScrolled('B', 0)
    rerender(<Strip tabs={['A', 'B', 'N', ...TABS.slice(2)]} active="B" />)
    expect(strip.scrollLeft).toBe(0)
    expect(tabX(strip, 'B')).toBe(100)
  })

  it('scrolls to the end for a foreground tab appended at the end', () => {
    const { strip, rerender } = mountScrolled('C', 0)
    rerender(<Strip tabs={[...TABS, 'N']} active="N" />)
    expect(strip.scrollLeft).toBe(800)
  })

  it('reveals a background tab appended past the end, beside the active tab', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    rerender(<Strip tabs={[...TABS, 'N']} active="J" />)
    expect(tabX(strip, 'J')).toBe(100)
    expect(tabX(strip, 'N')).toBe(200)
  })

  it('reveals a client-hosted row appended past the end', () => {
    const { strip, rerender } = mountScrolled('E', 300)
    rerender(<Strip tabs={TABS} hostedRows={['remote']} active="E" />)
    expect(strip.scrollLeft).toBe(800)
    expect(tabX(strip, 'remote')).toBe(200)
    expect(strip.dataset.dock).toBe('start')
  })

  it('reveals a tab that replaces another even when the strip count stays the same', () => {
    const { strip, rerender } = mountScrolled('B', 0)
    rerender(<Strip tabs={['A', 'B', ...TABS.slice(3), 'N']} active="B" />)
    expect(strip.scrollLeft).toBe(700)
    expect(tabX(strip, 'B')).toBe(0)
    expect(tabX(strip, 'N')).toBe(200)
  })

  it('does not scroll for a background tab while the pointer is over the strip', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    const matches = Element.prototype.matches.bind(strip)
    Object.defineProperty(strip, 'matches', {
      value: (selector: string) => selector === ':hover' || matches(selector)
    })
    rerender(<Strip tabs={[...TABS, 'N']} active="J" />)
    expect(strip.scrollLeft).toBe(700)
    expect(tabX(strip, 'J')).toBe(200)
  })

  it('reveals a background tab that opened under the pointer once the pointer leaves', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    const matches = Element.prototype.matches.bind(strip)
    Object.defineProperty(strip, 'matches', {
      value: (selector: string) => selector === ':hover' || matches(selector)
    })
    rerender(<Strip tabs={[...TABS, 'N']} active="J" />)
    act(() => {
      strip.parentElement!.dispatchEvent(new Event('pointerleave'))
    })
    expect(tabX(strip, 'J')).toBe(100)
    expect(tabX(strip, 'N')).toBe(200)
  })

  it('reveals a background tab that lands far from the active tab, which docks', () => {
    const { strip, rerender } = mountScrolled('B', 0)
    rerender(<Strip tabs={[...TABS, 'N']} active="B" />)
    expect(tabX(strip, 'N')).toBe(200)
    expect(strip.dataset.dock).toBe('start')
  })

  it('reveals a background tab that lands left of the viewed tab, which docks', () => {
    const { strip, rerender } = mountScrolled('F', 400)
    rerender(<Strip tabs={['A', 'B', 'N', ...TABS.slice(2)]} active="F" />)
    expect(tabX(strip, 'N')).toBe(0)
    expect(tabX(strip, 'F')).toBe(200)
    expect(strip.dataset.dock).toBe('end')
  })
})

describe('tab strip scroll when tabs are closed', () => {
  beforeEach(installStripLayout)
  afterEach(() => {
    cleanup()
    restoreStripLayout()
  })

  it('keeps the strip still when closing the active tab switches to a far tab', () => {
    const { strip, rerender } = mountScrolled('E', 300)
    rerender(<Strip tabs={TABS.filter((id) => id !== 'E')} active="A" />)
    expect(strip.scrollLeft).toBe(300)
    expect(strip.dataset.dock).toBe('start')
  })

  it('still reveals a later tab switch after a close', () => {
    const { strip, rerender } = mountScrolled('E', 300)
    const remaining = TABS.filter((id) => id !== 'E')
    rerender(<Strip tabs={remaining} active="A" />)
    rerender(<Strip tabs={remaining} active="J" />)
    expect(strip.scrollLeft).toBe(600)
    expect(tabX(strip, 'I')).toBe(100)
  })
})

/** The pointer rests on the strip; the close spacer reads the wrapper, deferred reveals the strip. */
function hoverStrip(strip: HTMLElement): void {
  for (const el of [strip, strip.parentElement!]) {
    const matches = Element.prototype.matches.bind(el)
    Object.defineProperty(el, 'matches', {
      configurable: true,
      value: (selector: string) => selector === ':hover' || matches(selector)
    })
  }
}

/** Click the tab's close button, the way a mouse close starts before the store removes the tab. */
function clickClose(strip: HTMLElement, id: string): void {
  strip
    .querySelector(`[data-tab-strip-slot="${id}"] [data-tab-close-button]`)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function leaveStrip(strip: HTMLElement): void {
  act(() => {
    strip.parentElement!.dispatchEvent(new Event('pointerleave'))
  })
}

describe('tab strip close made with the mouse', () => {
  beforeEach(installStripLayout)
  afterEach(() => {
    cleanup()
    restoreStripLayout()
  })

  const withoutI = TABS.filter((id) => id !== 'I')
  const withoutHI = TABS.filter((id) => id !== 'H' && id !== 'I')

  function closeIAtEnd() {
    const view = mountScrolled('J', 700)
    hoverStrip(view.strip)
    clickClose(view.strip, 'I')
    view.rerender(<Strip tabs={withoutI} active="J" />)
    return view
  }

  it('holds the scroll after a close at the end so the next tab slides under the cursor', () => {
    const { strip } = closeIAtEnd()
    expect(strip.scrollLeft).toBe(700)
    expect(tabX(strip, 'H')).toBe(0)
    expect(tabX(strip, 'J')).toBe(100)
  })

  it('settles once the pointer leaves the strip', () => {
    const { strip } = closeIAtEnd()
    leaveStrip(strip)
    expect(strip.scrollLeft).toBe(600)
    expect(tabX(strip, 'J')).toBe(200)
  })

  it('settles on a key press, since pointerleave can be swallowed', () => {
    const { strip } = closeIAtEnd()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }))
    })
    expect(strip.scrollLeft).toBe(600)
  })

  it('settles on a pointer press outside the strip', () => {
    const { strip } = closeIAtEnd()
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(strip.scrollLeft).toBe(600)
  })

  it('stacks a second close in the same spot', () => {
    const { strip, rerender } = closeIAtEnd()
    clickClose(strip, 'H')
    rerender(<Strip tabs={withoutHI} active="J" />)
    expect(strip.scrollLeft).toBe(700)
    expect(strip.scrollWidth).toBe(1000)
    expect(tabX(strip, 'J')).toBe(0)
  })

  it('lets an opened tab take the held space instead of dropping it', () => {
    const { strip, rerender } = closeIAtEnd()
    clickClose(strip, 'H')
    rerender(<Strip tabs={withoutHI} active="J" />)
    rerender(<Strip tabs={[...withoutHI, 'N']} active="J" />)
    expect(strip.scrollLeft).toBe(700)
    expect(strip.scrollWidth).toBe(1000)
    expect(tabX(strip, 'J')).toBe(0)
  })

  it('does not hold a close that did not come from the mouse, like a shortcut', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    hoverStrip(strip)
    rerender(<Strip tabs={withoutI} active="J" />)
    expect(strip.scrollLeft).toBe(600)
  })

  it('does not hold when the pointer is not over the strip', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    clickClose(strip, 'I')
    rerender(<Strip tabs={withoutI} active="J" />)
    expect(strip.scrollLeft).toBe(600)
    expect(tabX(strip, 'H')).toBe(100)
  })

  it('keeps the strip width for a close away from the end', () => {
    const { strip, rerender } = mountScrolled('A', 0)
    hoverStrip(strip)
    clickClose(strip, 'B')
    rerender(<Strip tabs={TABS.filter((id) => id !== 'B')} active="A" />)
    expect(strip.scrollWidth).toBe(1000)
    expect(tabX(strip, 'A')).toBe(0)
    expect(tabX(strip, 'C')).toBe(100)
  })

  it('keeps tabs from widening when a close drops the strip just under the overflow line', () => {
    const view = render(<Strip tabs={['A', 'B', 'C', 'D']} active="A" viewport={390} />)
    const strip = view.container.querySelector<HTMLElement>('[data-strip]')!
    hoverStrip(strip)
    clickClose(strip, 'B')
    view.rerender(<Strip tabs={['A', 'C', 'D']} active="A" viewport={390} />)
    const c = strip.querySelector<HTMLElement>('[data-tab-strip-slot="C"]')!.getBoundingClientRect()
    expect(c.width).toBe(100)
    expect(c.left).toBe(100)
  })

  it('does not hold the strip for a bulk close', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    hoverStrip(strip)
    clickClose(strip, 'H')
    rerender(<Strip tabs={withoutHI} active="J" />)
    expect(strip.scrollWidth).toBe(800)
    expect(strip.scrollLeft).toBe(500)
  })

  it('does not hold a strip that fit its tabs', () => {
    const view = render(<Strip tabs={['A', 'B', 'C']} active="A" viewport={600} />)
    const strip = view.container.querySelector<HTMLElement>('[data-strip]')!
    hoverStrip(strip)
    clickClose(strip, 'C')
    view.rerender(<Strip tabs={['A', 'B']} active="A" viewport={600} />)
    expect(strip.scrollWidth).toBe(360)
  })
})

describe('tab strip with a docked active tab', () => {
  beforeEach(installStripLayout)
  afterEach(() => {
    cleanup()
    restoreStripLayout()
  })

  it('reports the edge the active tab is docked to', () => {
    expect(mountScrolled('H', 0).strip.dataset.dock).toBe('end')
    cleanup()
    expect(mountScrolled('E', 300).strip.dataset.dock).toBeUndefined()
  })

  it('reports the dock edge when a client-hosted row takes and gives back the active state', () => {
    const { strip, rerender } = mountScrolled('E', 300, ['remote'])
    expect(strip.dataset.dock).toBeUndefined()
    rerender(<Strip tabs={TABS} hostedRows={['remote']} activeHostedRow="remote" active="E" />)
    expect(strip.dataset.dock).toBe('end')
    rerender(<Strip tabs={TABS} hostedRows={['remote']} active="E" />)
    expect(strip.dataset.dock).toBeUndefined()
  })

  it('reveals a foreground tab opened next to a docked active tab', () => {
    const { strip, rerender } = mountScrolled('H', 0)
    rerender(<Strip tabs={[...TABS.slice(0, 8), 'N', ...TABS.slice(8)]} active="N" />)
    expect(tabX(strip, 'N')).toBe(200)
    expect(tabX(strip, 'H')).toBe(100)
  })

  it('reveals a background tab opened right after a docked active tab, side by side', () => {
    const { strip, rerender } = mountScrolled('B', 500)
    expect(strip.dataset.dock).toBe('start')
    rerender(<Strip tabs={['A', 'B', 'N', ...TABS.slice(2)]} active="B" />)
    expect(tabX(strip, 'B')).toBe(0)
    expect(tabX(strip, 'N')).toBe(100)
    expect(strip.dataset.dock).toBeUndefined()
  })

  it('keeps a revealed background tab clear of the docked active tab', () => {
    const { strip, rerender } = mountScrolled('A', 700)
    rerender(<Strip tabs={[...TABS.slice(0, 5), 'N', ...TABS.slice(5)]} active="A" />)
    expect(tabX(strip, 'A')).toBe(0)
    expect(tabX(strip, 'N')).toBe(100)
  })
})
