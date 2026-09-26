// @vitest-environment happy-dom
import { Virtualizer } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import { scrollLineageVirtualizer } from './lineage-scroll-to'

function fixture(scrollTop = 400) {
  const element = document.createElement('div')
  element.scrollTop = scrollTop
  const scrollTo = vi.spyOn(element, 'scrollTo').mockImplementation(() => {})
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 100,
    getScrollElement: () => element,
    estimateSize: () => 100,
    initialOffset: () => element.scrollTop,
    scrollToFn: scrollLineageVirtualizer,
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn()
  })
  return { element, scrollTo, instance }
}

describe('inner lineage scroll writes', () => {
  it('attaches at the current offset without cancelling another owner’s animation', () => {
    const { instance, scrollTo } = fixture(25_000)

    instance._willUpdate()

    expect(instance.scrollOffset).toBe(25_000)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it.each([
    { offset: 400.25, adjustments: undefined },
    { offset: 400.25, adjustments: 0 },
    { offset: 400, adjustments: 0.25 },
    { offset: 425.5, adjustments: -25.25 }
  ])('skips only an implicit write to the actual effective offset: %j', (options) => {
    const { element, instance, scrollTo } = fixture(400.25)
    instance.scrollElement = element
    instance.scrollOffset = 0

    scrollLineageVirtualizer(options.offset, { adjustments: options.adjustments }, instance)

    expect(scrollTo).not.toHaveBeenCalled()
  })

  it.each(['auto', 'instant', 'smooth'] as const)(
    'preserves an explicit %s write even when it targets the current position',
    (behavior) => {
      const { element, instance, scrollTo } = fixture()
      instance.scrollElement = element

      scrollLineageVirtualizer(375, { adjustments: 25, behavior }, instance)

      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 400, behavior })
    }
  )

  it.each([
    { offset: 500, adjustments: undefined, target: 500 },
    { offset: 400.25, adjustments: undefined, target: 400.25 },
    { offset: 400, adjustments: 0.25, target: 400.25 },
    { offset: 400, adjustments: -25, target: 375 },
    { offset: 375, adjustments: 50, target: 425 }
  ])('delegates real movement, including fractional compensation: %j', (options) => {
    const { element, instance, scrollTo } = fixture()
    instance.scrollElement = element
    instance.scrollOffset = options.target

    scrollLineageVirtualizer(options.offset, { adjustments: options.adjustments }, instance)

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: options.target,
      behavior: undefined
    })
  })

  it('keeps retrying a required adjustment while the DOM offset remains clamped', () => {
    const { element, instance, scrollTo } = fixture()
    instance.scrollElement = element

    scrollLineageVirtualizer(400, { adjustments: 100 }, instance)
    scrollLineageVirtualizer(400, { adjustments: 100 }, instance)
    element.scrollTop = 500
    scrollLineageVirtualizer(400, { adjustments: 100 }, instance)

    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: undefined })
  })
})
