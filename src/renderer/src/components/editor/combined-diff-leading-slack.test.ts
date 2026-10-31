// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { observeElementOffset, Virtualizer } from '@tanstack/react-virtual'
import * as extentDOM from './combined-diff-extent-dom'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it.each([100, 1000])(
  'projects only mounted rows and selects the logical viewport across leading slack at %i files',
  (count) => {
    const viewport = document.createElement('div')
    const content = document.createElement('div')
    content.dataset.combinedDiffExtent = ''
    const row = document.createElement('div')
    row.dataset.combinedDiffSectionRow = ''
    row.dataset.index = '1'
    content.append(row)
    viewport.append(content)
    document.body.append(viewport)
    let top = 27
    const writes: number[] = []
    Object.defineProperties(viewport, {
      clientHeight: { value: 700 },
      scrollHeight: { get: () => Number.parseFloat(content.style.height || '20000') },
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
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count,
      getScrollElement: () => viewport,
      estimateSize: (index) => (index === 0 ? 1700 : 100),
      initialRect: { width: 800, height: 700 },
      initialOffset: 27,
      observeElementRect: (_instance, callback) => {
        callback({ width: 800, height: 700 })
        return () => {}
      },
      observeElementOffset: extentDOM.observeCombinedDiffOffset ?? observeElementOffset,
      scrollToFn: vi.fn(),
      onChange: (instance) => extentDOM.publishCombinedDiffMeasurements(instance)
    })
    const unmount = virtualizer._didMount()
    virtualizer._willUpdate()
    const disconnect = extentDOM.connectCombinedDiffExtent(viewport)
    extentDOM.publishCombinedDiffMeasurements(virtualizer)
    const owner = extentDOM.getCombinedDiffExtent(viewport)
    const saved = owner.capture(1, 32)
    if (!saved) {
      throw new Error('Expected the following item')
    }
    owner.restore(saved)
    virtualizer.resizeItem(0, 30)
    expect(top).toBe(0)
    expect(row.style.top).toBe('1673px')
    expect(virtualizer.getVirtualItems().map((item) => item.index)).toContain(1)
    let reads = 0
    const first = virtualizer.measurementsCache[0]
    if (!first) {
      throw new Error('Missing retained measurement')
    }
    const key = first.key
    Object.defineProperty(first, 'key', {
      get: () => {
        reads += 1
        return key
      }
    })
    for (let index = 0; index < 10; index += 1) {
      extentDOM.publishCombinedDiffMeasurements(virtualizer)
    }
    expect(reads).toBe(0)
    viewport.dispatchEvent(new Event('wheel'))
    viewport.scrollTop = 1800
    viewport.dispatchEvent(new Event('scroll'))
    expect(top).toBe(157)
    expect(row.style.top).toBe('30px')
    expect(virtualizer.scrollOffset).toBe(157)
    expect(virtualizer.getVirtualItems().map((item) => item.index)).toContain(2)
    expect(writes).toEqual([0, 1800, 157])
    disconnect()
    unmount()
  }
)
