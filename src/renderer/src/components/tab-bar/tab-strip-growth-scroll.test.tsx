// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useTabStripOverflowNavigation } from './tab-strip-overflow-navigation'

const TAB_WIDTH = 100
const VIEWPORT_WIDTH = 300

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

/** 100px tabs in a 300px strip; a tab's x is its index minus the strip's scroll, clamped into view when docked. */
function installStripLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? this.children.length * TAB_WIDTH : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return isStrip(this) ? VIEWPORT_WIDTH : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: Element) {
      return scrollLeftByElement.get(this) ?? 0
    },
    set(this: Element, value: number) {
      const max = Math.max(0, this.scrollWidth - this.clientWidth)
      scrollLeftByElement.set(this, Math.min(max, Math.max(0, value)))
    }
  })
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (isStrip(this)) {
      return rect(0, VIEWPORT_WIDTH)
    }
    const strip = this.parentElement
    if (strip && isStrip(strip)) {
      const index = Array.from(strip.children).indexOf(this)
      const left = index * TAB_WIDTH - strip.scrollLeft
      const docked = this.hasAttribute('data-active-tab-dock')
      return rect(
        docked ? Math.min(VIEWPORT_WIDTH - TAB_WIDTH, Math.max(0, left)) : left,
        TAB_WIDTH
      )
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
  activeHostedRow = null
}: {
  tabs: string[]
  active: string
  hostedRows?: string[]
  activeHostedRow?: string | null
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
      data-dock={navigation.activeTabDockSide ?? undefined}
      ref={navigation.tabStripRef}
    >
      {tabs.map((id) => (
        <div
          key={id}
          data-tab-id={id}
          data-tab-strip-slot={id}
          data-active-tab-dock={id === active && !activeHostedRow ? '' : undefined}
        />
      ))}
      {hostedRows.map((id) => (
        <div
          key={id}
          data-tab-strip-slot={id}
          data-active-tab-dock={id === activeHostedRow ? '' : undefined}
        />
      ))}
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
      strip.dispatchEvent(new Event('pointerleave'))
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
