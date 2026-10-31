// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { Virtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { CombinedDiffExtent } from './combined-diff-extent'
import {
  connectCombinedDiffExtent,
  getCombinedDiffExtent,
  publishCombinedDiffMeasurements,
  scrollCombinedDiffToIndex
} from './combined-diff-extent-dom'

function items(heights: number[], keys = heights.map((_, index) => String(index))): VirtualItem[] {
  let start = 0
  return heights.map((size, index) => {
    const item = {
      key: keys[index] ?? String(index),
      index,
      lane: 0,
      start,
      size,
      end: start + size
    }
    start += size
    return item
  })
}

function fixture(heights: number[], initial = 0) {
  let position = initial
  let range = 0
  const writes: number[] = []
  const project = vi.fn((_items: readonly VirtualItem[], height: number) => {
    range = height
  })
  const owner = new CombinedDiffExtent({
    position: () => position,
    height: () => 700,
    project,
    write: (target) => {
      position = Math.max(0, Math.min(range - 700, target))
      writes.push(position)
    }
  })
  owner.publish(items(heights))
  return {
    owner,
    writes,
    project,
    position: () => position,
    input: (value: number) => {
      owner.input()
      position = value
      owner.scrolled()
    }
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('materializes trailing slack before the sole bottom-expansion write, then consumes a late 20px publication', () => {
  const f = fixture([60000, 977], 60277)
  f.owner.transact(1, 400, () => f.owner.publish(items([60000, 1357])))
  expect(f.position()).toBe(60677)
  expect(f.owner.trailingSlack).toBe(20)
  expect(f.writes).toEqual([60677])
  f.owner.publish(items([60000, 1377]))
  expect(f.owner.trailingSlack).toBe(0)
  expect(f.position()).toBe(60677)
  expect(f.writes).toEqual([60677])
  expect(f.project.mock.invocationCallOrder.at(-1)).toBeGreaterThan(0)
})

it.each(['delayed', 'settled'])(
  'maps saved item identity through %s prefix growth around go-to cancellation',
  (timing) => {
    const f = fixture([670, 20000], 27)
    const saved = f.owner.capture(1, 32)
    expect(saved).not.toBeNull()
    f.owner.navigate(10274)
    if (timing === 'settled') {
      f.owner.publish(items([870, 20000]))
    }
    if (saved) {
      f.owner.restore(saved)
    }
    f.owner.publish(items([870, 20000]))
    expect(f.position()).toBe(227)
    expect(870 + 32 - f.position()).toBe(675)
    const writes = f.writes.length
    f.owner.publish(items([870, 20000]))
    expect(f.writes).toHaveLength(writes)
  }
)

it('maps ordinary growth above the viewport, leaves spanning growth stable, and replaces anchors on input', () => {
  const f = fixture([1000, 20000], 1200)
  f.owner.publish(items([1200, 20000]))
  expect(f.position()).toBe(1400)
  f.owner.publish(items([1200, 21000]))
  expect(f.position()).toBe(1400)
  f.input(20)
  f.owner.publish(items([1300, 21000]))
  expect(f.position()).toBe(20)
  const saved = f.owner.capture(1, 32)
  if (saved) {
    f.owner.restore(saved)
    f.owner.invalidate(saved.key)
  }
  f.owner.publish(items([1400, 21000], ['replaced', 'new-model']))
  expect(f.position()).toBe(20)
})

it('consumes slack on manual scrolling and drops removed identities without a deferred writer', () => {
  const f = fixture([60000, 977], 60277)
  f.owner.transact(1, 400, () => f.owner.publish(items([60000, 1357])))
  f.input(60500)
  expect(f.owner.trailingSlack).toBe(0)
  f.owner.publish(items([60000, 1377]))
  expect(f.position()).toBe(60500)
  f.owner.publish(items([1000], ['replacement']))
  expect(f.owner.revision).toBe(4)
  expect(f.writes).toEqual([60677, 300])
})

it('uses real virtualizer staged measurements with a lagging DOM range and no independent compensation', () => {
  const viewport = document.createElement('div')
  const content = document.createElement('div')
  content.dataset.combinedDiffExtent = ''
  viewport.append(content)
  document.body.append(viewport)
  let top = 60277
  const writes: number[] = []
  Object.defineProperties(viewport, {
    clientHeight: { value: 700 },
    scrollHeight: { get: () => Number.parseFloat(content.style.height || '60977') },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(viewport.scrollHeight - 700, value))
        writes.push(top)
      }
    }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const disconnect = connectCombinedDiffExtent(viewport)
  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 2,
    getScrollElement: () => viewport,
    estimateSize: (index) => (index === 0 ? 60000 : 977),
    initialOffset: 60277,
    initialRect: { width: 800, height: 700 },
    observeElementRect: (_instance, callback) => {
      callback({ width: 800, height: 700 })
      return () => {}
    },
    observeElementOffset: (_instance, callback) => {
      callback(top, false)
      return () => {}
    },
    scrollToFn: vi.fn(),
    onChange: publishCombinedDiffMeasurements
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const unmount = virtualizer._didMount()
  virtualizer._willUpdate()
  publishCombinedDiffMeasurements(virtualizer)
  const owner = getCombinedDiffExtent(viewport)
  owner.transact(1, 400, () => virtualizer.resizeItem(1, 1357))
  expect(top).toBe(60677)
  expect(viewport.scrollHeight).toBe(61377)
  expect(owner.trailingSlack).toBe(20)
  virtualizer.resizeItem(1, 1377)
  expect(owner.trailingSlack).toBe(0)
  expect(writes).toEqual([60677])
  expect(viewport.style.overflowAnchor).toBe('none')
  const before = writes.length
  scrollCombinedDiffToIndex(virtualizer, 1)
  scrollCombinedDiffToIndex(virtualizer, 1)
  expect(writes.slice(before)).toEqual([60000])
  const saved = owner.capture(1, 32)
  owner.navigate(500)
  if (saved) {
    owner.restore(saved)
  }
  virtualizer.resizeItem(0, 60200)
  expect(top).toBe(60200)
  unmount()
  disconnect()
})

it('derives a visible focused-item priority without retaining a direction timer', () => {
  const focused = fixture([670, 20000], 27)
  focused.owner.publish(items([870, 20000]), '1')
  expect(focused.position()).toBe(227)
  const ordinary = fixture([670, 20000], 27)
  ordinary.owner.publish(items([870, 20000]))
  expect(ordinary.position()).toBe(27)
  const offscreen = fixture([670, 20000], 2000)
  offscreen.owner.publish(items([870, 20000]), '0')
  expect(offscreen.position()).toBe(2200)
})

it('does not rescan retained file extents on ordinary scroll at N and 10N files', () => {
  for (const count of [100, 1000]) {
    let reads = 0
    const layout = items(Array.from({ length: count }, () => 1000)).map((item) => ({
      ...item,
      get key() {
        reads += 1
        return item.key
      }
    }))
    const f = fixture([])
    f.owner.publish(layout)
    reads = 0
    for (let index = 0; index < 10; index += 1) {
      f.input(index * 100)
      f.owner.publish(layout)
    }
    expect(reads).toBe(0)
  }
})
