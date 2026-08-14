// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  computeTabStripEndInset,
  computeTabStripScrollLeft,
  findLastTabStripTab,
  isLastTabStripTab,
  syncTabStripEndPad,
  TAB_STRIP_REVEAL_INSET_PX
} from './tab-strip-active-tab-scroll'

function mockBox(
  el: HTMLElement,
  box: {
    offsetLeft?: number
    offsetWidth?: number
    clientWidth?: number
    scrollWidth?: number
  }
): void {
  Object.defineProperties(el, {
    offsetLeft: { configurable: true, value: box.offsetLeft ?? 0 },
    offsetWidth: { configurable: true, value: box.offsetWidth ?? 0 },
    clientWidth: { configurable: true, value: box.clientWidth ?? 0 },
    scrollWidth: { configurable: true, value: box.scrollWidth ?? 0 }
  })
}

describe('computeTabStripEndInset', () => {
  it('is zero when tabs already fit', () => {
    expect(
      computeTabStripEndInset({
        stripClientWidth: 400,
        lastTabWidth: 180,
        contentWidth: 360
      })
    ).toBe(0)
  })

  it('uses the fade-sized inset when the last tab overflows', () => {
    expect(
      computeTabStripEndInset({
        stripClientWidth: 400,
        lastTabWidth: 180,
        contentWidth: 900
      })
    ).toBe(TAB_STRIP_REVEAL_INSET_PX)
  })

  it('shrinks the inset when the last tab almost fills the strip', () => {
    expect(
      computeTabStripEndInset({
        stripClientWidth: 200,
        lastTabWidth: 190,
        contentWidth: 400
      })
    ).toBe(10)
  })

  it('is zero when the last tab is at least as wide as the strip', () => {
    expect(
      computeTabStripEndInset({
        stripClientWidth: 180,
        lastTabWidth: 180,
        contentWidth: 400
      })
    ).toBe(0)
  })
})

// Derives scrollWidth from the live pad policy so tests can't assert unreachable geometry.
function lastTabGeometry({
  stripClientWidth,
  lastTabWidth,
  lastTabOffsetLeft
}: {
  stripClientWidth: number
  lastTabWidth: number
  lastTabOffsetLeft: number
}): {
  stripScrollWidth: number
  stripClientWidth: number
  tabOffsetLeft: number
  tabWidth: number
} {
  const contentWidth = lastTabOffsetLeft + lastTabWidth
  const pad = computeTabStripEndInset({ stripClientWidth, lastTabWidth, contentWidth })
  return {
    stripScrollWidth: contentWidth + pad,
    stripClientWidth,
    tabOffsetLeft: lastTabOffsetLeft,
    tabWidth: lastTabWidth
  }
}

describe('computeTabStripScrollLeft', () => {
  it('stops a normal-width last tab at the fade inset because the pad caps the range', () => {
    const geometry = lastTabGeometry({
      stripClientWidth: 400,
      lastTabWidth: 180,
      lastTabOffsetLeft: 720
    })
    const scrollLeft = computeTabStripScrollLeft({
      ...geometry,
      stripScrollLeft: 0,
      inline: 'center'
    })

    expect(scrollLeft).toBe(geometry.stripScrollWidth - geometry.stripClientWidth)
    const tabEnd = geometry.tabOffsetLeft + geometry.tabWidth - scrollLeft
    expect(geometry.stripClientWidth - tabEnd).toBe(TAB_STRIP_REVEAL_INSET_PX)
  })

  it('centers a last tab once the pad covers the required trailing range', () => {
    const geometry = lastTabGeometry({
      stripClientWidth: 200,
      lastTabWidth: 190,
      lastTabOffsetLeft: 210
    })

    expect(computeTabStripScrollLeft({ ...geometry, stripScrollLeft: 0, inline: 'center' })).toBe(
      geometry.tabOffsetLeft + geometry.tabWidth / 2 - geometry.stripClientWidth / 2
    )
  })

  it('keeps a fully visible middle tab in place', () => {
    expect(
      computeTabStripScrollLeft({
        stripScrollWidth: 900,
        stripClientWidth: 400,
        stripScrollLeft: 200,
        tabOffsetLeft: 280,
        tabWidth: 120,
        inline: 'nearest'
      })
    ).toBe(200)
  })

  it('scrolls far enough that a clipped trailing tab clears the fade inset', () => {
    expect(
      computeTabStripScrollLeft({
        stripScrollWidth: 900,
        stripClientWidth: 400,
        stripScrollLeft: 0,
        tabOffsetLeft: 320,
        tabWidth: 180,
        inline: 'nearest'
      })
    ).toBe(320 + 180 - 400 + TAB_STRIP_REVEAL_INSET_PX)
  })
})

describe('tab strip last-tab helpers', () => {
  it('treats the last data-tab-id node as the last tab and ignores the end pad', () => {
    const strip = document.createElement('div')
    const first = document.createElement('div')
    first.setAttribute('data-tab-id', 'one')
    const last = document.createElement('div')
    last.setAttribute('data-tab-id', 'two')
    const pad = document.createElement('div')
    pad.setAttribute('data-tab-strip-end-pad', '')
    strip.append(first, last, pad)

    expect(findLastTabStripTab(strip)).toBe(last)
    expect(isLastTabStripTab(strip, last)).toBe(true)
    expect(isLastTabStripTab(strip, first)).toBe(false)
  })

  it('sizes the end pad to the fade inset when the last tab overflows', () => {
    const strip = document.createElement('div')
    const last = document.createElement('div')
    last.setAttribute('data-tab-id', 'end')
    const pad = document.createElement('div')
    pad.setAttribute('data-tab-strip-end-pad', '')
    strip.append(last, pad)
    mockBox(strip, { clientWidth: 400 })
    mockBox(last, { offsetLeft: 720, offsetWidth: 180 })

    expect(syncTabStripEndPad(strip)).toBe(TAB_STRIP_REVEAL_INSET_PX)
    expect(pad.style.width).toBe(`${TAB_STRIP_REVEAL_INSET_PX}px`)
  })

  it('clears the end pad when every tab already fits', () => {
    const strip = document.createElement('div')
    const last = document.createElement('div')
    last.setAttribute('data-tab-id', 'end')
    const pad = document.createElement('div')
    pad.setAttribute('data-tab-strip-end-pad', '')
    pad.style.width = '110px'
    strip.append(last, pad)
    mockBox(strip, { clientWidth: 400 })
    mockBox(last, { offsetLeft: 0, offsetWidth: 180 })

    expect(syncTabStripEndPad(strip)).toBe(0)
    expect(pad.style.width).toBe('0px')
  })
})
