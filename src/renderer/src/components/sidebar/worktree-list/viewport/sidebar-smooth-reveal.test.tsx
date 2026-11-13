// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { supersedeVirtualizedScrollAnchorRestore } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { revealElementInScrollContainer } from '../navigation/worktree-sidebar-reveal'
import { useWorktreeListVirtualizer } from './use-virtualizer'
import { useVirtualRowMeasurementSync } from './use-row-measurement'
import { useWorktreeSidebarScrollSuppression } from './use-scroll-suppression'

const caches = vi.hoisted(() => ({ prCache: {}, issueCache: {} }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof caches) => unknown) => selector(caches)
}))
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setup() {
  const scroller = document.createElement('div')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    clientHeight: { value: 300 },
    offsetHeight: { value: 300 },
    offsetWidth: { value: 300 },
    scrollHeight: { value: 10000 }
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300)
  scroller.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && options.behavior !== 'smooth') {
      scroller.scrollTop = options.top ?? scroller.scrollTop
    }
  }
  const rows: RenderRow[] = Array.from({ length: 60 }, (_, index) => ({
    type: 'item',
    rowKey: String(index),
    sectionKey: 'all',
    repo,
    worktree: { ...worktree, id: String(index) },
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }))
  const scrollRef = { current: scroller }
  const scrollOffsetRef = { current: 0 }
  const scrollAnchorRef: { current: VirtualizedScrollAnchor } = { current: null }
  const marks = createProgrammaticScrollMarks()
  const view = renderHook(() => {
    const projection = useMemo(() => buildLineageRowProjection(rows, 'none', false), [])
    const virtualization = useWorktreeListVirtualizer({
      renderRows: rows,
      projection,
      firstHeaderIndex: -1,
      scrollRef,
      scrollOffsetRef,
      programmaticScrollMarks: marks
    })
    const input = useWorktreeSidebarScrollSuppression(scrollRef)
    useVirtualRowMeasurementSync({
      renderRows: rows,
      virtualization,
      scrollRef,
      scrollOffsetRef,
      scrollAnchorRef,
      shouldSkipScrollAnchorRestore: input.shouldSkipScrollAnchorRestore
    })
    return { ...virtualization, input }
  })
  const mount = (index: number, height: number) => {
    const element = document.createElement('div')
    element.setAttribute('data-index', String(index))
    element.setAttribute('data-worktree-virtual-row', '')
    element.setAttribute('data-worktree-virtual-row-key', `wt:${index}`)
    Object.defineProperty(element, 'offsetHeight', { value: height })
    scroller.append(element)
    act(() => view.result.current.virtualizer.measureElement(element))
    return element
  }
  return { scroller, view, mount, scrollAnchorRef }
}

it('measures skipped mounted rows and new rows after late direct takeover without rewinding a stale offset', () => {
  const { scroller, view, mount } = setup()
  act(() => {
    view.result.current.input.markRevealScroll(3000)
    view.result.current.virtualizer.scrollToOffset(3000, { behavior: 'smooth' })
  })
  mount(0, 93)
  vi.spyOn(window.performance, 'now').mockReturnValue(10000)
  expect(view.result.current.input.shouldSkipScrollAnchorRestore()).toBe(false)
  scroller.scrollTop = 50
  act(() => view.result.current.input.markDirectScrollInput())
  expect(scroller.scrollTop).toBe(50)
  expect(view.result.current.virtualizer.measurementsCache[0].size).toBe(93)
  mount(1, 115)
  expect(view.result.current.virtualizer.measurementsCache[2].start).toBe(208)
})

it.each(['arrival', 'idle', 'replacement', 'no-op'] as const)(
  'releases measurement after %s instead of leaving the smooth target active',
  (completion) => {
    const { scroller, view, mount } = setup()
    act(() => view.result.current.virtualizer.scrollToOffset(3000, { behavior: 'smooth' }))
    mount(0, 93)
    act(() => {
      if (completion === 'replacement') {
        view.result.current.virtualizer.scrollToIndex(0, { behavior: 'auto' })
      } else if (completion === 'no-op') {
        view.result.current.virtualizer.scrollToOffset(0, { behavior: 'smooth' })
      } else {
        scroller.scrollTop = completion === 'arrival' ? 3000 : 80
        scroller.dispatchEvent(new Event('scroll'))
        if (completion === 'idle') {
          vi.advanceTimersByTime(250)
        }
      }
    })
    expect(view.result.current.virtualizer.measurementsCache[0].size).toBe(93)
    mount(1, 115)
    expect(view.result.current.virtualizer.measurementsCache[2].start).toBe(208)
    view.unmount()
    scroller.scrollTop = 37
    supersedeVirtualizedScrollAnchorRestore(scroller)
    expect(scroller.scrollTop).toBe(37)
  }
)

it.each(['virtualizer', 'native'] as const)(
  'records later user movement back to a completed %s reveal destination',
  (writer) => {
    const { scroller, view, scrollAnchorRef } = setup()
    const target = document.createElement('div')
    target.getBoundingClientRect = () => new DOMRect(0, 350 - scroller.scrollTop, 300, 50)
    scroller.append(target)
    act(() => {
      revealElementInScrollContainer(
        scroller,
        target,
        'auto',
        undefined,
        writer === 'virtualizer'
          ? (top) => view.result.current.virtualizer.scrollToOffset(top, { behavior: 'auto' })
          : undefined
      )
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(scroller.scrollTop).toBe(100)
    act(() => {
      scroller.scrollTop = 20
      scroller.dispatchEvent(new Event('scroll'))
      scroller.scrollTop = 100
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(scrollAnchorRef.current?.offset).toBe(100)
  }
)
