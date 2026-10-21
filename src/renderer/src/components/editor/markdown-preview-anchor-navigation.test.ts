// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import {
  scrollMarkdownPreviewTo,
  scrollMarkdownPreviewVirtualizer
} from './markdown-preview-anchor-navigation'

function scrollContainer() {
  const container = document.createElement('div')
  vi.spyOn(container, 'scrollTo').mockImplementation((options: number | ScrollToOptions) => {
    if (typeof options === 'object') {
      container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, 500))
    }
  })
  return container
}

function createVirtualizer(container: HTMLDivElement) {
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 10,
    getScrollElement: () => container,
    estimateSize: () => 100,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {}
  })
  virtualizer.scrollElement = container
  return virtualizer
}

describe('large preview programmatic scroll marks', () => {
  it('marks clamped virtualizer corrections and leaves subsequent user scrolling unmarked', () => {
    const container = scrollContainer()
    const marks = createProgrammaticScrollMarks()
    const virtualizer = createVirtualizer(container)
    scrollMarkdownPreviewVirtualizer(480, { adjustments: 100 }, virtualizer, marks)
    expect(container.scrollTop).toBe(500)
    expect(marks.consume(new Event('scroll'), 500, 500)).toBe(true)
    expect(marks.consume(new Event('scroll'), 450, 500)).toBe(false)
  })

  it('marks exact navigation writes without leaving stale marks for no-op writes', () => {
    const container = scrollContainer()
    const marks = createProgrammaticScrollMarks()
    scrollMarkdownPreviewTo(container, 250, marks)
    expect(marks.consume(new Event('scroll'), 250, 500)).toBe(true)
    scrollMarkdownPreviewTo(container, 250, marks)
    expect(marks.consume(new Event('scroll'), 251, 500)).toBe(false)
    scrollMarkdownPreviewTo(container, 900, marks)
    expect(marks.consume(new Event('scroll'), 500, 500)).toBe(true)
    scrollMarkdownPreviewVirtualizer(500, {}, createVirtualizer(container), marks)
    expect(marks.consume(new Event('scroll'), 499, 500)).toBe(false)
  })
})
