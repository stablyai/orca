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

/** 100px tabs in a 300px strip; a tab's x is its index minus the strip's scroll. */
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
      return rect(index * TAB_WIDTH - strip.scrollLeft, TAB_WIDTH)
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

function Strip({ tabs, active }: { tabs: string[]; active: string }): React.JSX.Element {
  const navigation = useTabStripOverflowNavigation({
    activeVisibleTabId: active,
    layoutKey: tabs.join(','),
    tabCount: tabs.length,
    worktreeId: 'wt-1'
  })
  return (
    <div data-strip="" ref={navigation.tabStripRef}>
      {tabs.map((id) => (
        <div key={id} data-tab-id={id} />
      ))}
    </div>
  )
}

const TABS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']

function mountScrolled(active: string, scrollLeft: number) {
  const view = render(<Strip tabs={TABS} active={active} />)
  const strip = view.container.querySelector<HTMLElement>('[data-strip]')!
  act(() => {
    strip.scrollLeft = scrollLeft
    strip.dispatchEvent(new Event('scroll'))
  })
  return { ...view, strip }
}

function tabX(strip: HTMLElement, id: string): number {
  return strip.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!.getBoundingClientRect().left
}

describe('tab strip scroll when tabs are added', () => {
  beforeEach(installStripLayout)
  afterEach(() => {
    cleanup()
    restoreStripLayout()
  })

  it('keeps the viewed tab still when a background tab lands to its left', () => {
    const { strip, rerender } = mountScrolled('F', 400)
    expect(tabX(strip, 'F')).toBe(100)
    rerender(<Strip tabs={['A', 'B', 'N', ...TABS.slice(2)]} active="F" />)
    expect(tabX(strip, 'F')).toBe(100)
  })

  it('keeps the viewed tab still when a background tab lands after it', () => {
    const { strip, rerender } = mountScrolled('F', 400)
    rerender(<Strip tabs={[...TABS.slice(0, 6), 'N', ...TABS.slice(6)]} active="F" />)
    expect(strip.scrollLeft).toBe(400)
    expect(tabX(strip, 'F')).toBe(100)
  })

  it('does not jump to the end for a background tab while pinned to the end', () => {
    const { strip, rerender } = mountScrolled('J', 700)
    rerender(<Strip tabs={[...TABS, 'N']} active="J" />)
    expect(tabX(strip, 'J')).toBe(200)
  })

  it('scrolls to the end for a foreground tab appended at the end', () => {
    const { strip, rerender } = mountScrolled('C', 0)
    rerender(<Strip tabs={[...TABS, 'N']} active="N" />)
    expect(strip.scrollLeft).toBe(800)
  })
})
