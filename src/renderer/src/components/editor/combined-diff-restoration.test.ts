// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { connectCombinedDiffExtent, getCombinedDiffExtent } from './combined-diff-extent-dom'
import { CombinedDiffExtent, type CombinedDiffViewImport } from './combined-diff-extent'

const saved: CombinedDiffViewImport = {
  scrollTop: 21237,
  anchor: { key: 'clip-a', offset: 19050 }
}
const rows = (sizes: number[], settled = true, keys = ['clip-0', 'clip-a', 'clip-b']) => {
  let start = 0
  return sizes.map((size, index) => {
    const item = { key: keys[index]!, index, lane: 0, start, size, end: start + size, settled }
    start += size
    return item
  })
}

function fixture(initialHeight = 0) {
  let height = initialHeight
  let extent = 0
  let top = 0
  const writes: number[] = []
  const owner = new CombinedDiffExtent({
    position: () => top,
    height: () => height,
    scrollHeight: () => Math.max(height, extent),
    project: (_items, value) => {
      extent = value
      top = Math.max(0, Math.min(top, extent - height))
    },
    write: (value) => {
      top = Math.max(0, Math.min(value, extent - height))
      writes.push(top)
    }
  })
  return {
    owner,
    writes,
    top: () => top,
    height: (value: number) => {
      height = value
      top = Math.max(0, Math.min(top, extent - height))
    },
    move: (value: number) => {
      top = value
    }
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it.each([
  'resize-scroll-publish',
  'scroll-publish-resize',
  'publish-resize-scroll',
  'resize-publish-scroll',
  'scroll-resize-publish',
  'publish-scroll-resize'
])(
  'retains the T3 request across placeholder clamps and %s, then keeps later prefix growth',
  (order) => {
    const f = fixture()
    f.owner.publish(rows([91, 91, 91], false))
    f.owner.importView(saved)
    expect(f.owner.exportView()).toEqual(saved)
    f.height(803)
    const steps = {
      resize: () => f.owner.scrolled(),
      scroll: () => f.owner.scrolled(),
      publish: () => f.owner.publish(rows([91, 91, 91], false))
    }
    for (const step of order.split('-')) {
      if (step === 'resize' || step === 'scroll' || step === 'publish') {
        steps[step]()
      }
      expect(f.owner.exportView()).toEqual(saved)
    }
    f.owner.publish(rows([2387, 20067, 19000]))
    expect(f.top()).toBe(21437)
    expect(f.owner.exportView().anchor).toMatchObject({ key: 'clip-a', offset: 19050 })
    f.owner.publish(rows([2487, 20067, 19000]))
    expect(f.top()).toBe(21537)
  }
)

it('does not accept placeholder equality or manufactured slack as a completed anchored or scalar restore', () => {
  for (const state of [saved, { scrollTop: 21237 }]) {
    const f = fixture(803)
    f.owner.publish(rows([2200, 22000, 22000], false))
    f.owner.importView(state)
    expect(f.owner.exportView()).toEqual(state)
    const incoming = fixture(803)
    incoming.owner.importView(f.owner.exportView())
    incoming.owner.publish(rows([2387, 20067, 19000]))
    expect(incoming.top()).toBe(state.anchor ? 21437 : 21237)
  }
})

it.each(['input', 'navigate', 'restore'])(
  'lets %s supersede restoration even in the same dimension-change turn',
  (kind) => {
    const f = fixture(803)
    f.owner.publish(rows([91, 91, 91], false))
    f.owner.importView(saved)
    expect(f.owner.exportView()).toEqual(saved)
    f.height(900)
    if (kind === 'input') {
      f.owner.input()
      f.move(0)
      f.owner.scrolled()
    } else if (kind === 'navigate') {
      f.owner.navigate(0)
    } else {
      f.owner.restore({ key: 'clip-0', offset: 0, gap: 0 })
    }
    f.owner.publish(rows([2387, 20067, 19000]))
    expect(f.top()).toBe(0)
    expect(f.owner.exportView().anchor?.key).not.toBe('clip-a')
  }
)

it('acknowledges an ordinary anchor resize clamp but adopts an unexplained unchanged-dimensions move', () => {
  const f = fixture(803)
  f.owner.publish(rows([2387, 20067, 19000]))
  f.owner.importView(saved)
  f.height(50000)
  f.owner.scrolled()
  expect(f.top()).toBe(21437)
  expect(f.owner.exportView().anchor?.key).toBe('clip-a')
  f.move(100)
  f.owner.scrolled()
  f.owner.publish(rows([2487, 20067, 19000]))
  expect(f.top()).toBe(100)
})

it('ends pending work at confirmed removal, empty content and current-model shorter geometry', () => {
  const f = fixture(803)
  f.owner.publish(rows([91, 91, 91], false))
  f.owner.importView(saved)
  expect(f.owner.exportView()).toEqual(saved)
  f.owner.publish(rows([1000], true, ['clip-b']))
  expect(f.owner.exportView()).not.toEqual(saved)
  f.owner.publish(rows([2387, 20067, 19000]))
  expect(f.owner.exportView().anchor?.key).not.toBe('clip-a')
  f.owner.publish(rows([91, 91, 91], false))
  f.owner.importView(saved)
  f.owner.publish(rows([2387, 30, 19000]))
  expect(f.owner.exportView().anchor).toMatchObject({ key: 'clip-a', offset: 30 })
  f.owner.importView(saved)
  f.owner.publish([])
  expect(f.owner.exportView()).toMatchObject({ scrollTop: 0, anchor: null })
})

it.each(['wheel', 'touchmove', 'pointerdown', 'dispose'])(
  'cancels the pending binding on real %s even before geometry is published',
  (event) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    const viewport = document.createElement('div')
    const content = document.createElement('div')
    content.dataset.combinedDiffExtent = ''
    viewport.append(content)
    document.body.append(viewport)
    let top = 0
    Object.defineProperties(viewport, {
      clientHeight: { value: 803 },
      scrollHeight: { get: () => Math.max(803, Number.parseFloat(content.style.height || '0')) },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, viewport.scrollHeight - 803))
        }
      }
    })
    const disconnect = connectCombinedDiffExtent(viewport)
    const owner = getCombinedDiffExtent(viewport)
    owner.publish(rows([91, 91, 91], false))
    owner.importView(saved)
    expect(owner.exportView()).toEqual(saved)
    if (event === 'dispose') {
      disconnect()
    } else {
      viewport.dispatchEvent(new Event(event))
    }
    owner.publish(rows([2387, 20067, 19000]))
    expect(owner.exportView().anchor?.key).not.toBe('clip-a')
    expect(top).not.toBe(21437)
    disconnect()
  }
)

it('retires outgoing model geometry before importing a new context on the same viewport', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  Object.defineProperty(viewport, 'clientHeight', { value: 803 })
  const disconnect = connectCombinedDiffExtent(viewport)
  const owner = getCombinedDiffExtent(viewport)
  owner.publish(rows([2387, 20067, 19000]))
  owner.importView(saved)
  expect(owner.exportView().scrollTop).toBe(21437)
  disconnect()
  owner.importView(saved)
  const nextDisconnect = connectCombinedDiffExtent(viewport)
  expect(owner.exportView()).toEqual(saved)
  owner.publish(rows([3000, 20067, 19000], false))
  expect(viewport.scrollTop).toBe(22050)
  expect(owner.exportView()).toEqual(saved)
  owner.publish(rows([3000, 20067, 19000]))
  expect(owner.exportView().scrollTop).toBe(22050)
  nextDisconnect()
})
