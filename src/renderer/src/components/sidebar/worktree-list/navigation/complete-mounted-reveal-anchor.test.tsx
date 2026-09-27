// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { completeMountedSidebarReveal } from './complete-mounted-reveal'

afterEach(cleanup)

it('keeps the corrected descendant landing when an owed outer anchor restore resumes', () => {
  const container = document.createElement('div')
  const group = document.createElement('div')
  const target = document.createElement('div')
  group.dataset.worktreeVirtualRow = ''
  group.append(target)
  container.append(group)
  Object.defineProperty(container, 'clientHeight', { value: 743 })
  Object.defineProperty(container, 'scrollHeight', { value: 20_000 })
  container.scrollTop = 11_605
  container.getBoundingClientRect = () => new DOMRect(0, 0, 200, 743)
  group.getBoundingClientRect = () => new DOMRect(0, -container.scrollTop, 200, 20_000)
  target.getBoundingClientRect = () => new DOMRect(0, 8_973 - container.scrollTop, 200, 55)
  container.scrollTo = (...args) => {
    const options = args[0]
    const top = typeof options === 'number' ? args[1] : options?.top
    container.scrollTop = top ?? container.scrollTop
  }
  const anchorRef: { current: VirtualizedScrollAnchor } = {
    current: { key: 'group', offset: 11_605, scrollTop: 11_605 }
  }
  const scrollOffsetRef = { current: 11_605 }
  const scrollElementRef = { current: container }
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 1,
    getScrollElement: () => container,
    estimateSize: () => 20_000,
    getItemKey: () => 'group',
    initialOffset: 11_605,
    initialRect: { width: 200, height: 743 },
    observeElementRect: () => undefined,
    observeElementOffset: () => undefined,
    scrollToFn: () => {}
  })
  let settling = true
  const { rerender } = renderHook(
    ({ totalSize }) =>
      useVirtualizedScrollAnchor({
        anchorRef,
        getItemElementKey: () => 'group',
        getRowKey: (key) => key,
        itemElementSelector: '[data-worktree-virtual-row]',
        restoreSignal: 'group-order',
        rows: ['group'],
        scrollElementRef,
        scrollOffsetRef,
        shouldSkipRestore: () => settling,
        totalSize,
        virtualizer
      }),
    { initialProps: { totalSize: 20_000 } }
  )
  const frames: FrameRequestCallback[] = []
  const complete = vi.fn()
  completeMountedSidebarReveal({
    container,
    element: target,
    behavior: 'smooth',
    cancelled: () => false,
    isScrollSettling: () => settling,
    wasScrollInterrupted: () => false,
    markRevealScroll: () => {},
    scheduleFrame: (frame) => frames.push(frame),
    complete
  })
  settling = false
  frames.shift()?.(0)
  expect(container.scrollTop).toBe(8_939)
  expect(complete).not.toHaveBeenCalled()

  // The layout tick lands between the correction and its completion frame.
  rerender({ totalSize: 19_999 })
  frames.shift()?.(0)
  expect(complete).toHaveBeenCalledExactlyOnceWith(true)
  expect(container.scrollTop).toBe(8_939)
  expect(target.getBoundingClientRect().top).toBe(34)
  expect(anchorRef.current?.scrollTop).toBe(8_939)
})
