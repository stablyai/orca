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
})
