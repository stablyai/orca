// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { revealElementInScrollContainer } from '../navigation/worktree-sidebar-reveal'
import { useVirtualRowMeasurementSync } from './use-row-measurement'
import { useWorktreeSidebarScrollSuppression } from './use-scroll-suppression'
import { preserveDeleteSiblingPosition } from '../../workspace-actions/context-menu/worktree-context-menu-policy'
import type { WorktreeListVirtualizer } from './use-virtualizer'

const caches = vi.hoisted(() => ({ prCache: {}, issueCache: {} }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof caches) => unknown) => selector(caches)
}))

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id))
})
afterEach(() => {
  cleanup()
  frames.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function row(id: string): RenderRow {
  return {
    type: 'item',
    rowKey: id,
    sectionKey: 'all',
    repo,
    worktree: { ...worktree, id },
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

function setup(interior = false) {
  const scroller = document.createElement('div')
  scroller.setAttribute('data-worktree-sidebar', '')
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 4000 }
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400)
  scroller.scrollTop = 1000
  scroller.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'object') {
      scroller.scrollTop = options.top ?? 0
    }
  }
  const model = {
    sizes: new Map<string, number>(),
    starts: new Map([
      ['a', 0],
      ['b', 1000],
      ['c', 2000],
      ['d', 3000]
    ]),
    items: interior ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'],
    totalSize: 4000
  }
  const mount = (id: string) => {
    const element = document.createElement('div')
    element.setAttribute('data-worktree-virtual-row', '')
    element.setAttribute('data-worktree-virtual-row-key', `wt:${id}`)
    element.getBoundingClientRect = () =>
      new DOMRect(
        0,
        (model.starts.get(id) ?? 0) - scroller.scrollTop,
        300,
        model.sizes.get(id) ?? 1000
      )
    scroller.append(element)
    return element
  }
  const mounted = mount('b')
  const virtualizer = {
    elementsCache: new Map(),
    getTotalSize: () => model.totalSize,
    getVirtualItems: () =>
      model.items.map((id, index) => ({
        index,
        key: `wt:${id}`,
        start: model.starts.get(id) ?? 0,
        end: (model.starts.get(id) ?? 0) + (model.sizes.get(id) ?? 1000),
        size: model.sizes.get(id) ?? 1000,
        lane: 0
      })),
    measureElement: () => {},
    isScrolling: false,
    scrollOffset: null,
    scrollToIndex: () => {
      scroller.scrollTop = 500
    }
  }
  const scrollRef = { current: scroller }
  const scrollOffsetRef = { current: 1000 }
  const scrollAnchorRef: { current: VirtualizedScrollAnchor } = { current: null }
  const marks = createProgrammaticScrollMarks()
  const view = renderHook(
    ({ rows }: { rows: RenderRow[] }) => {
      const projection = useMemo(() => buildLineageRowProjection(rows, 'none', false), [rows])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the geometry and virtualizer methods consumed by the production measurement/anchor integration.
      const virtualization = {
        virtualizer,
        isCurrentVirtualRowElement: () => true,
        stickyHeaderIndexes: [],
        activeStickyHeaderIndexRef: { current: null },
        activeStickyHostIndexRef: { current: null },
        stickyRangeStartIndexRef: { current: 0 },
        rowIndexByKey: projection.rowIndexByKey,
        restoreSignal: projection.restoreSignal,
        programmaticScrollMarks: marks
      } as unknown as WorktreeListVirtualizer
      const input = useWorktreeSidebarScrollSuppression(scrollRef)
      useVirtualRowMeasurementSync({
        renderRows: rows,
        virtualization,
        scrollRef,
        scrollOffsetRef,
        scrollAnchorRef,
        shouldSkipScrollAnchorRestore: input.shouldSkipScrollAnchorRestore
      })
      return input
    },
    {
      initialProps: {
        rows: interior
          ? [row('a'), { ...row('b'), depth: 1 }, { ...row('c'), depth: 1 }, row('d')]
          : [row('a'), row('b'), row('c')]
      }
    }
  )
  act(() => requestVirtualizedScrollAnchorRecord(scroller))
  return { scroller, model, mount, mounted, view }
}

it('leaves height-only scroll correction to the virtualizer instead of restoring an older DOM position', () => {
  const { scroller, model, view } = setup()
  act(() => {
    scroller.scrollTop = 1200
    scroller.dispatchEvent(new Event('scroll'))
  })
  model.starts.set('b', 950)
  model.totalSize = 3950
  view.rerender({ rows: [row('a'), row('b'), row('c')] })
  expect(scroller.scrollTop).toBe(1200)
})

it('preserves the visible occurrence when rows before it disappear', () => {
  const { scroller, model, mounted, view } = setup()
  act(() => {
    scroller.scrollTop = 1020
    scroller.dispatchEvent(new Event('scroll'))
  })
  model.starts.set('b', 0)
  model.starts.set('c', 1000)
  model.items = ['b', 'c']
  model.totalSize = 3000
  view.rerender({ rows: [row('b'), row('c')] })
  expect(scroller.scrollTop).toBe(20)
  expect(mounted.getBoundingClientRect().top).toBe(-20)
})

it('lets an already-visible explicit reveal supersede a pending offscreen restore', () => {
  const { scroller, model, mounted, mount, view } = setup()
  mounted.remove()
  model.items = []
  view.rerender({ rows: [row('b'), row('c')] })
  expect(scroller.scrollTop).toBe(500)
  model.starts.set('c', 550)
  const destination = mount('c')
  destination.getBoundingClientRect = () => new DOMRect(0, 550 - scroller.scrollTop, 300, 100)
  model.starts.set('b', 400)
  model.sizes.set('b', 100)
  const oldTarget = mount('b')
  oldTarget.getBoundingClientRect = () => new DOMRect(0, 400 - scroller.scrollTop, 300, 100)
  model.items = ['b', 'c']
  act(() => {
    expect(revealElementInScrollContainer(scroller, destination, 'auto')).toBe(true)
    const pendingFrames = [...frames]
    for (const [id, callback] of pendingFrames) {
      frames.delete(id)
      callback(0)
    }
  })
  expect(scroller.scrollTop).toBe(500)
  expect(destination.getBoundingClientRect().top).toBe(50)
})

function finishPositioning() {
  act(() => {
    for (let turn = 0; turn < 12 && frames.size; turn++) {
      const pendingFrames = [...frames]
      for (const [id, callback] of pendingFrames) {
        frames.delete(id)
        callback(0)
      }
    }
  })
}

it('lets no-op direct input retire an old target and preserve position on a later insertion', () => {
  const { scroller, model, mounted, mount, view } = setup()
  mounted.remove()
  model.items = []
  view.rerender({ rows: [row('b'), row('c')] })
  model.starts.set('b', 400)
  model.sizes.set('b', 100)
  const oldTarget = mount('b')
  oldTarget.getBoundingClientRect = () => new DOMRect(0, 400 - scroller.scrollTop, 300, 100)
  model.starts.set('c', 480)
  const destination = mount('c')
  model.items = ['b', 'c']
  act(() => view.result.current.markDirectScrollInput())
  finishPositioning()
  expect(scroller.scrollTop).toBe(500)
  expect(destination.getBoundingClientRect().top).toBe(-20)
  model.starts.set('c', 680)
  model.items = ['b', 'new', 'c']
  view.rerender({ rows: [row('b'), row('new'), row('c')] })
  expect(scroller.scrollTop).toBe(700)
  expect(destination.getBoundingClientRect().top).toBe(-20)
})

it('keeps an interior descendant successor at the removed card position after action takeover', () => {
  const { scroller, model, mounted, mount, view } = setup(true)
  model.sizes.set('b', 200)
  model.starts.set('c', 1200)
  model.starts.set('d', 2200)
  model.totalSize = 3200
  const successor = mount('c')
  act(() => {
    scroller.scrollTop = 1020
    scroller.dispatchEvent(new Event('scroll'))
  })
  const position = preserveDeleteSiblingPosition(mounted)
  // The real teardown boundary records the live viewport immediately before its row mutation.
  act(() => requestVirtualizedScrollAnchorRecord(scroller))
  mounted.remove()
  model.starts.set('c', 1000)
  model.starts.set('d', 2000)
  model.items = ['a', 'c', 'd']
  model.totalSize = 3000
  view.rerender({ rows: [row('a'), { ...row('c'), depth: 1 }, row('d')] })
  expect(scroller.scrollTop).toBe(1000)
  act(position)
  view.rerender({ rows: [row('a'), { ...row('c'), depth: 1 }, row('d')] })
  expect(scroller.scrollTop).toBe(1020)
  finishPositioning()
  expect(scroller.scrollTop).toBe(1020)
  expect(successor.getBoundingClientRect().top).toBe(-20)
})

it('preserves the live viewport when delayed removal follows completed positioning and user scrolling', () => {
  const { scroller, model, mounted, mount, view } = setup(true)
  const successor = mount('c')
  const position = preserveDeleteSiblingPosition(mounted)
  act(position)
  finishPositioning()
  act(() => {
    scroller.scrollTop = 2100
    scroller.dispatchEvent(new Event('scroll'))
    requestVirtualizedScrollAnchorRecord(scroller)
  })
  mounted.remove()
  model.starts.set('c', 1000)
  model.starts.set('d', 2000)
  model.items = ['a', 'c', 'd']
  model.totalSize = 3000
  view.rerender({ rows: [row('a'), { ...row('c'), depth: 1 }, row('d')] })
  finishPositioning()
  expect(scroller.scrollTop).toBe(1100)
  expect(successor.getBoundingClientRect().top).toBe(-100)
})
