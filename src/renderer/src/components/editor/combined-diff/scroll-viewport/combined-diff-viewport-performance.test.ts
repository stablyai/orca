// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import { CombinedDiffViewportOwner, type DiffViewportItem } from './combined-diff-viewport-owner'

function mountViewport(owner: CombinedDiffViewportOwner, height: () => number): () => void {
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { get: () => (height() > 0 ? 800 : 0) },
    clientHeight: { get: height }
  })
  document.body.append(host)
  const unmount = owner.mount(host)
  return () => {
    unmount()
    owner.dispose()
    host.remove()
  }
}

function inputs(files: number): {
  key: string
  generation: string
  height: number
  collapsed: boolean
  index: number
}[] {
  return Array.from({ length: files }, (_, index) => ({
    key: `file-${index}`,
    generation: '1',
    height: 1000,
    collapsed: false,
    index
  }))
}

async function commit(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function observeExtentBufferReads(index: CombinedDiffExtentIndex, read: () => void): () => void {
  const restore: (() => void)[] = []
  for (const [key, value] of Object.entries(index)) {
    if (!Array.isArray(value)) {
      continue
    }
    Reflect.set(
      index,
      key,
      new Proxy(value, {
        get(target, property) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            read()
          }
          const descriptor =
            Object.getOwnPropertyDescriptor(target, property) ??
            Object.getOwnPropertyDescriptor(Array.prototype, property) ??
            Object.getOwnPropertyDescriptor(Object.prototype, property)
          return descriptor?.value
        }
      })
    )
    restore.push(() => Reflect.set(index, key, value))
  }
  return () => restore.forEach((reset) => reset())
}

it.each([200, 2000])(
  'keeps native work and publications bounded while scrolling %i long files',
  async (files) => {
    const NativeResizeObserver = globalThis.ResizeObserver
    let resize = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          super(callback)
          resize = () => callback([], this)
        }
      }
    )
    let viewportHeight = 500
    const owner = new CombinedDiffViewportOwner()
    const unmount = mountViewport(owner, () => viewportHeight)
    const mounted = new Map<DiffViewportItem, () => void>()
    let applications = 0
    let heightReads = 0
    let bindings = 0
    let detaches = 0
    let publications = 0
    let extentReads = 0
    let captures = 0
    let persisted: ReturnType<CombinedDiffViewportOwner['getAnchor']> = null
    const reconcileRows = (): void => {
      const visible = new Set(owner.getSnapshot())
      for (const [item, dispose] of mounted) {
        if (!visible.has(item)) {
          dispose()
          mounted.delete(item)
        }
      }
      for (const item of visible) {
        if (mounted.has(item)) {
          continue
        }
        bindings++
        const node = document.createElement('div')
        owner.scene.append(node)
        owner.setNode(item, node)
        let attached = true
        let offset = 0
        const point = {
          resolveScrollTop: (displacement: number) => {
            const layout = owner.getItemLayout(item.key)
            return layout ? layout.start + offset - displacement : null
          },
          project: () => {
            const layout = owner.getItemLayout(item.key)
            return layout ? layout.start + offset - owner.getScrollTop() : null
          },
          isValid: () => attached,
          dispose: () => {}
        }
        const unbind = owner.bind(item, {
          apply: () => {
            applications++
          },
          readHeight: () => {
            heightReads++
            return 1000
          },
          capture: (edge) => {
            captures++
            const layout = owner.getItemLayout(item.key)!
            const top = layout.renderedStart - owner.getLayout().renderedTop
            if (edge < top || edge > top + layout.renderedHeight) {
              return null
            }
            offset = owner.getScrollTop() - layout.start + edge
            return point
          },
          hasFocus: () => false,
          detach: () => {
            detaches++
            attached = false
          }
        })
        mounted.set(item, () => {
          unbind()
          owner.setNode(item, null)
          node.remove()
        })
      }
    }
    const unsubscribe = owner.subscribe(reconcileRows)
    const unsubscribeScroll = owner.subscribeScroll(() => {
      publications++
      persisted = owner.getAnchor()
    })
    try {
      owner.setItems(inputs(files))
      await commit()
      owner.navigate(files - 7)
      await commit()
      for (let index = 0; index < files; index++) {
        const item = owner.getItem(`file-${index}`)!
        let value = item.height
        Object.defineProperty(item, 'height', {
          get: () => {
            extentReads++
            return value
          },
          set: (height) => {
            value = height
          }
        })
      }
      extentReads = 0
      captures = 0
      const rebuild = vi.spyOn(CombinedDiffExtentIndex.prototype, 'rebuildSuffix')
      const project = vi.spyOn(CombinedDiffExtentIndex.prototype, 'itemLayout')
      const windows = vi.spyOn(CombinedDiffExtentIndex.prototype, 'project')
      let bufferReads = 0
      let restoreBuffers: (() => void) | undefined
      const lookupReads: number[] = []
      const anchorAt = CombinedDiffExtentIndex.prototype.anchorAt
      const lookup = vi
        .spyOn(CombinedDiffExtentIndex.prototype, 'anchorAt')
        .mockImplementation(function (this: CombinedDiffExtentIndex, offset) {
          restoreBuffers ??= observeExtentBufferReads(this, () => bufferReads++)
          const before = bufferReads
          const anchor = anchorAt.call(this, offset)
          lookupReads.push(bufferReads - before)
          return anchor
        })
      try {
        owner.getAnchor()
        const assertLookupWork = (): void => {
          const comparisons = Math.ceil(Math.log2(files + 1)) + 1
          // Two transactions: input plus newly mounted geometry; each may render twice and capture/export once.
          expect(windows.mock.calls.length).toBeLessThanOrEqual(4)
          expect(lookup.mock.calls.length).toBeLessThanOrEqual(4)
          expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(publications)
          for (const reads of lookupReads) {
            // Besides binary comparisons, an anchor reads its key, total and selected prefix/height.
            expect(reads).toBeLessThanOrEqual(comparisons + 3)
          }
          // Eight lookups plus bounded window/row bookkeeping, including semantic capture and persistence.
          expect(bufferReads).toBeLessThanOrEqual(8 * comparisons + 4 * 16 + 20 * 4 + 4 * 3)
        }
        bufferReads = 0
        lookupReads.length = 0
        lookup.mockClear()
        applications = 0
        publications = 0
        // Native focus/selection scrolling enters through the real scene event listener.
        owner.root.scrollTop = 100
        owner.root.dispatchEvent(new Event('scroll'))
        await commit()
        expect(owner.getScrollTop()).toBe((files - 7) * 1000 + 100)
        expect(publications).toBe(1)
        // Two layout phases, at most two intersecting 1000px rows in a 500px viewport.
        expect(applications).toBeLessThanOrEqual(4)
        expect(rebuild).not.toHaveBeenCalled()
        expect(extentReads).toBe(0)
        expect(captures).toBe(1)
        expect(owner.getLayout().items.length).toBe(1)
        // One projected row and one attached transition row; capture/export are bounded independently of N.
        expect(project.mock.calls.length).toBeLessThanOrEqual(4)
        expect(persisted).toEqual({ key: `file-${files - 7}`, offset: 100 })
        assertLookupWork()
        // A crossing can mount two rows: one input render, one preparation and one
        // promoted render, plus bounded point readback. None requires scanning N.
        for (const [delta, expected] of [
          [1000, (files - 6) * 1000 + 100],
          [-1000, (files - 7) * 1000 + 100],
          [-200, (files - 8) * 1000 + 900]
        ]) {
          applications = 0
          publications = 0
          extentReads = 0
          captures = 0
          bufferReads = 0
          lookupReads.length = 0
          rebuild.mockClear()
          project.mockClear()
          windows.mockClear()
          lookup.mockClear()
          owner.input(delta)
          await commit()
          expect(owner.getScrollTop()).toBe(expected)
          expect(rebuild).not.toHaveBeenCalled()
          expect(extentReads).toBeLessThanOrEqual(4)
          expect(captures).toBeLessThanOrEqual(4)
          expect(applications).toBeLessThanOrEqual(10)
          expect(project.mock.calls.length).toBeLessThanOrEqual(20)
          expect(publications).toBeLessThanOrEqual(2)
          expect(persisted).toEqual({
            key: `file-${Math.floor(expected / 1000)}`,
            offset: expected % 1000
          })
          expect(mounted.size).toBeLessThanOrEqual(2)
          assertLookupWork()
        }
        const snapshot = owner.getSnapshot()
        const memory = owner.getViewMemory()
        const bound = bindings
        expect(snapshot.length).toBeGreaterThanOrEqual(2)
        applications = heightReads = detaches = 0
        rebuild.mockClear()
        viewportHeight = 0
        resize()
        await commit()
        owner.invalidate(snapshot[0])
        await commit()
        expect(applications).toBe(0)
        expect(heightReads).toBe(0)
        expect(detaches).toBe(0)
        expect(bindings).toBe(bound)
        expect(rebuild).not.toHaveBeenCalled()
        expect(owner.getSnapshot()).toBe(snapshot)
        expect(owner.getViewMemory()).toEqual(memory)
        viewportHeight = 500
        resize()
        await commit()
        expect(bindings).toBe(bound)
        expect(detaches).toBe(0)
        expect(rebuild).not.toHaveBeenCalled()
        // One preparation before native height reads, then one final projection.
        expect(applications).toBeLessThanOrEqual(2 * snapshot.length)
        expect(heightReads).toBe(snapshot.length)
        expect(owner.getViewMemory()).toEqual(memory)
        viewportHeight = 0
        resize()
        await commit()
        const pending = { scrollAnchor: { key: 'file-1', offset: 200 }, scrollTop: 1200 }
        owner.importView(pending.scrollAnchor, pending.scrollTop)
        owner.setItems([], false)
        await commit()
        expect(owner.getViewMemory()).toEqual(pending)
        expect(owner.getSnapshot()).toEqual([])
        applications = 0
        owner.setItems([], true)
        await commit()
        expect(owner.getViewMemory()).toEqual({ scrollAnchor: null, scrollTop: 0 })
        owner.setItems(inputs(files))
        await commit()
        expect(owner.getSnapshot()).toEqual([])
        expect(applications).toBe(0)
        viewportHeight = 500
        resize()
        await commit()
        expect(owner.getScrollTop()).toBe(0)
      } finally {
        restoreBuffers?.()
        lookup.mockRestore()
        windows.mockRestore()
        rebuild.mockRestore()
        project.mockRestore()
      }
    } finally {
      unsubscribe()
      unsubscribeScroll()
      for (const dispose of mounted.values()) {
        dispose()
      }
      unmount()
      vi.unstubAllGlobals()
    }
  }
)
