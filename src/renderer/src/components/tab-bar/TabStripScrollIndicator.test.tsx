// @vitest-environment happy-dom

import React, { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'
import type { TabStripScrollMetrics } from './tab-strip-scroll-metrics'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const OVERFLOW_METRICS: TabStripScrollMetrics = {
  hasOverflow: true,
  canScrollStart: false,
  canScrollEnd: true,
  thumbSizeFraction: 0.4,
  thumbOffsetFraction: 0
}

const NO_OVERFLOW_METRICS: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0
}

describe('TabStripScrollIndicator', () => {
  it('renders null when there is no overflow', () => {
    const { container } = render(<TabStripScrollIndicator metrics={NO_OVERFLOW_METRICS} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders under the tabs with bottom-0 and idle 2px height', () => {
    const { getByTestId } = render(<TabStripScrollIndicator metrics={OVERFLOW_METRICS} />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator).toBeTruthy()
    expect(indicator.className).toContain('bottom-0')
    expect(indicator.className).toContain('h-[2px]')
    expect(indicator.className).toContain('z-[12]')
    expect(indicator.className).toContain('opacity-0')
    expect(indicator.className).toContain('group-hover/tab-strip:opacity-100')

    const thumb = getByTestId('tab-strip-scroll-thumb')
    expect(thumb).toBeTruthy()
  })

  it('expands to 3px and becomes opaque on pointer hover, restores on leave', () => {
    const { getByTestId } = render(<TabStripScrollIndicator metrics={OVERFLOW_METRICS} />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator.className).toContain('h-[2px]')
    expect(indicator.className).toContain('opacity-0')

    fireEvent.pointerEnter(indicator)
    expect(indicator.className).toContain('h-[3px]')
    expect(indicator.className).toContain('opacity-100')

    fireEvent.pointerLeave(indicator)
    expect(indicator.className).toContain('h-[2px]')
    expect(indicator.className).toContain('opacity-0')
  })

  it('applies pointer-events-none when disabled', () => {
    const { getByTestId } = render(
      <TabStripScrollIndicator metrics={OVERFLOW_METRICS} disabled={true} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator.className).toContain('pointer-events-none')
    expect(indicator.className).not.toContain('group-hover/tab-strip:pointer-events-auto')
  })

  it('stays hidden and unexpanded on hover when disabled', () => {
    const { getByTestId } = render(
      <TabStripScrollIndicator metrics={OVERFLOW_METRICS} disabled={true} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    fireEvent.pointerEnter(indicator)
    expect(indicator.className).toContain('opacity-0')
    expect(indicator.className).not.toContain('opacity-100')
    expect(indicator.className).toContain('h-[2px]')
  })

  it('does not forward wheel events when disabled', () => {
    const scrollContainer = document.createElement('div')
    scrollContainer.scrollLeft = 0
    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator
        metrics={OVERFLOW_METRICS}
        scrollContainerRef={scrollContainerRef}
        disabled={true}
      />
    )
    fireEvent.wheel(getByTestId('tab-strip-scroll-indicator'), { deltaX: 40, deltaY: 0 })

    expect(scrollContainer.scrollLeft).toBe(0)
  })

  it('forwards wheel events to scrollContainer', () => {
    const scrollContainer = document.createElement('div')
    scrollContainer.scrollLeft = 0
    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator metrics={OVERFLOW_METRICS} scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    fireEvent.wheel(indicator, { deltaX: 40, deltaY: 0 })

    expect(scrollContainer.scrollLeft).toBe(40)
  })

  it('handles track click and smooth scrolls container', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    scrollContainer.scrollLeft = 0
    const scrollToMock = vi.fn()
    scrollContainer.scrollTo = scrollToMock

    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator metrics={OVERFLOW_METRICS} scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })
    vi.spyOn(indicator, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 500,
      top: 30,
      bottom: 33,
      width: 400,
      height: 3,
      x: 100,
      y: 30,
      toJSON: () => {}
    } as DOMRect)

    // Click track at clientX = 300 (offset 200 within 400px track)
    fireEvent.pointerDown(indicator, { button: 0, clientX: 300 })
    expect(scrollToMock).toHaveBeenCalledTimes(1)
    expect(scrollToMock).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: 'smooth'
      })
    )
  })

  it('scrolls container when dragging thumb', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    scrollContainer.scrollLeft = 0

    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator
        metrics={{
          ...OVERFLOW_METRICS,
          thumbSizeFraction: 0.4
        }}
        scrollContainerRef={scrollContainerRef}
      />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })
    const thumb = getByTestId('tab-strip-scroll-thumb')

    // Start drag on thumb
    fireEvent.pointerDown(thumb, { button: 0, clientX: 50 })
    expect(indicator.className).toContain('h-[3px]')

    // Move pointer by 60px
    fireEvent(window, new MouseEvent('pointermove', { clientX: 110 }))
    expect(scrollContainer.scrollLeft).toBeGreaterThan(0)

    // Release drag
    fireEvent(window, new MouseEvent('pointerup'))
    expect(indicator.className).toContain('h-[2px]')
  })

  it('cancels an active thumb drag when it becomes disabled', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    scrollContainer.scrollLeft = 0

    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId, rerender } = render(
      <TabStripScrollIndicator metrics={OVERFLOW_METRICS} scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })

    fireEvent.pointerDown(getByTestId('tab-strip-scroll-thumb'), { button: 0, clientX: 50 })
    expect(document.body.style.userSelect).toBe('none')

    rerender(
      <TabStripScrollIndicator
        metrics={OVERFLOW_METRICS}
        scrollContainerRef={scrollContainerRef}
        disabled={true}
      />
    )

    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')

    fireEvent(window, new MouseEvent('pointermove', { clientX: 300 }))
    expect(scrollContainer.scrollLeft).toBe(0)
  })
})
