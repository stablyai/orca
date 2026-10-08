// @vitest-environment happy-dom

import React, { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { TabStripScrollIndicator } from './TabStripScrollIndicator'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TabStripScrollIndicator', () => {
  it('renders null when there is no overflow', () => {
    const { container } = render(<TabStripScrollIndicator hasOverflow={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders under the tabs with bottom-0 and idle 3px height', () => {
    const { getByTestId } = render(<TabStripScrollIndicator hasOverflow />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator).toBeTruthy()
    expect(indicator.className).toContain('bottom-0')
    expect(indicator.className).toContain('h-[3px]')
    expect(indicator.className).toContain('z-[12]')
    expect(indicator.className).toContain('opacity-0')
    expect(indicator.className).toContain('group-hover/tab-strip:opacity-100')

    const thumb = getByTestId('tab-strip-scroll-thumb')
    expect(thumb).toBeTruthy()
  })

  it('expands to 4px and becomes opaque on pointer hover, restores on leave', () => {
    const { getByTestId } = render(<TabStripScrollIndicator hasOverflow />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator.className).toContain('h-[3px]')
    expect(indicator.className).toContain('opacity-0')

    fireEvent.pointerEnter(indicator)
    expect(indicator.className).toContain('h-[4px]')
    expect(indicator.className).toContain('opacity-100')

    fireEvent.pointerLeave(indicator)
    expect(indicator.className).toContain('h-[3px]')
    expect(indicator.className).toContain('opacity-0')
  })

  it('applies state-specific track and thumb colors across idle, hover, and drag', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator hasOverflow scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })
    const thumb = getByTestId('tab-strip-scroll-thumb')

    expect(indicator.className).toContain('bg-transparent')
    expect(indicator.className).not.toContain('bg-muted-foreground/15')
    expect(thumb.className).toContain('bg-muted-foreground/60')
    expect(thumb.className).not.toContain('bg-muted-foreground/80')
    expect(thumb.className).not.toContain('bg-foreground/70')

    fireEvent.pointerEnter(indicator)
    expect(indicator.className).toContain('bg-muted-foreground/15')
    expect(indicator.className).not.toContain('bg-transparent')
    expect(thumb.className).toContain('bg-muted-foreground/80')
    expect(thumb.className).not.toContain('bg-muted-foreground/60')

    fireEvent.pointerDown(thumb, { button: 0, clientX: 50 })
    expect(indicator.className).toContain('bg-muted-foreground/15')
    expect(thumb.className).toContain('bg-foreground/70')
    expect(thumb.className).not.toContain('bg-muted-foreground/80')

    fireEvent(window, new MouseEvent('pointerup'))
    fireEvent.pointerLeave(indicator)
    expect(indicator.className).toContain('bg-transparent')
    expect(thumb.className).toContain('bg-muted-foreground/60')
  })

  it('applies pointer-events-none when disabled', () => {
    const { getByTestId } = render(<TabStripScrollIndicator hasOverflow disabled={true} />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    expect(indicator.className).toContain('pointer-events-none')
    expect(indicator.className).not.toContain('group-hover/tab-strip:pointer-events-auto')
  })

  it('stays hidden and unexpanded on hover when disabled', () => {
    const { getByTestId } = render(<TabStripScrollIndicator hasOverflow disabled={true} />)
    const indicator = getByTestId('tab-strip-scroll-indicator')
    fireEvent.pointerEnter(indicator)
    expect(indicator.className).toContain('opacity-0')
    expect(indicator.className).not.toContain('opacity-100')
    expect(indicator.className).toContain('h-[3px]')
  })

  it('does not forward wheel events when disabled', () => {
    const scrollContainer = document.createElement('div')
    scrollContainer.scrollLeft = 0
    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId } = render(
      <TabStripScrollIndicator
        hasOverflow
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
      <TabStripScrollIndicator hasOverflow scrollContainerRef={scrollContainerRef} />
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
      <TabStripScrollIndicator hasOverflow scrollContainerRef={scrollContainerRef} />
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
      <TabStripScrollIndicator hasOverflow scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })
    const thumb = getByTestId('tab-strip-scroll-thumb')

    // Start drag on thumb
    fireEvent.pointerDown(thumb, { button: 0, clientX: 50 })
    expect(indicator.className).toContain('h-[4px]')

    // 60px of a 240px thumb travel scrolls 60/240 of the 600px scroll range
    fireEvent(window, new MouseEvent('pointermove', { clientX: 110 }))
    expect(scrollContainer.scrollLeft).toBe(150)

    // Release drag
    fireEvent(window, new MouseEvent('pointerup'))
    expect(indicator.className).toContain('h-[3px]')
  })

  it('cancels an active thumb drag when it becomes disabled', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    scrollContainer.scrollLeft = 0

    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer

    const { getByTestId, rerender } = render(
      <TabStripScrollIndicator hasOverflow scrollContainerRef={scrollContainerRef} />
    )
    const indicator = getByTestId('tab-strip-scroll-indicator')
    Object.defineProperty(indicator, 'clientWidth', { value: 400, configurable: true })

    fireEvent.pointerDown(getByTestId('tab-strip-scroll-thumb'), { button: 0, clientX: 50 })
    expect(document.body.style.userSelect).toBe('none')

    rerender(
      <TabStripScrollIndicator
        hasOverflow
        scrollContainerRef={scrollContainerRef}
        disabled={true}
      />
    )

    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')

    fireEvent(window, new MouseEvent('pointermove', { clientX: 300 }))
    expect(scrollContainer.scrollLeft).toBe(0)
  })

  it('sizes the thumb when overflow appears and keeps it in step with scrolling and tab changes', () => {
    const scrollContainer = document.createElement('div')
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(scrollContainer, 'clientWidth', { value: 400, configurable: true })
    const scrollContainerRef = createRef<HTMLElement>()
    ;(scrollContainerRef as React.MutableRefObject<HTMLElement>).current = scrollContainer
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.testid === 'tab-strip-scroll-indicator'
        ? 400
        : clientWidth.get!.call(this)
    })

    const stripResizeListeners = new Set<() => void>()
    const subscribeToStripResize = (listener: () => void): (() => void) => {
      stripResizeListeners.add(listener)
      return () => stripResizeListeners.delete(listener)
    }

    const { getByTestId, rerender, unmount } = render(
      <TabStripScrollIndicator
        hasOverflow={false}
        scrollContainerRef={scrollContainerRef}
        subscribeToStripResize={subscribeToStripResize}
      />
    )
    rerender(
      <TabStripScrollIndicator
        hasOverflow
        scrollContainerRef={scrollContainerRef}
        subscribeToStripResize={subscribeToStripResize}
      />
    )
    const thumb = getByTestId('tab-strip-scroll-thumb')
    expect(thumb.style.width).toBe('160px')
    expect(thumb.style.transform).toBe('translateX(0px)')

    scrollContainer.scrollLeft = 300
    fireEvent.scroll(scrollContainer)
    expect(thumb.style.transform).toBe('translateX(120px)')

    // The thumb's geometry is not a React prop, so a re-render for hover must not reset it.
    fireEvent.pointerEnter(getByTestId('tab-strip-scroll-indicator'))
    expect(getByTestId('tab-strip-scroll-thumb')).toBe(thumb)
    expect(thumb.style.width).toBe('160px')
    expect(thumb.style.transform).toBe('translateX(120px)')

    // A tab opening grows the strip without a scroll event.
    Object.defineProperty(scrollContainer, 'scrollWidth', { value: 2000, configurable: true })
    stripResizeListeners.forEach((listener) => listener())
    expect(thumb.style.width).toBe('80px')

    unmount()
    expect(stripResizeListeners.size).toBe(0)
  })
})
