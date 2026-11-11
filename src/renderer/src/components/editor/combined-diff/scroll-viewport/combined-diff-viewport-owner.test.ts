// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import { CombinedDiffInputs } from './combined-diff-inputs'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { CombinedDiffViewportOwner, type DiffViewportItem } from './combined-diff-viewport-owner'

function mountViewport(owner: CombinedDiffViewportOwner): () => void {
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { value: 800 },
    clientHeight: { value: 500 }
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
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            read()
          }
          return Reflect.get(target, property, receiver)
        }
      })
    )
    restore.push(() => Reflect.set(index, key, value))
  }
  return () => restore.forEach((reset) => reset())
}

describe('combined diff viewport publication', () => {
  it('applies width before measuring and publishes the corrected reading position once', async () => {
    const owner = new CombinedDiffViewportOwner()
    const unmount = mountViewport(owner)
    owner.setItems(inputs(2))
    await commit()
    const item = owner.getSnapshot()[0]
    let height = 1000
    let requestedHeight = 1000
    const node = document.createElement('div')
    owner.scene.append(node)
    owner.setNode(item, node)
    owner.bind(item, {
      apply: () => {
        height = requestedHeight
      },
      readHeight: () => height,
      capture: () => null,
      hasFocus: () => false,
      detach: () => {}
    })
    await commit()
    owner.input(1100)
    owner.input(-400)
    const published: number[] = []
    const unsubscribe = owner.subscribeScroll(() => published.push(owner.getScrollTop()))
    try {
      requestedHeight = 2000
      owner.invalidate()
      await commit()
      expect(owner.getItemLayout('file-1')!.start - owner.getScrollTop()).toBe(300)
      expect(published).toEqual([1700])
    } finally {
      unsubscribe()
      unmount()
    }
  })

  it.each([200, 2000])(
    'keeps native work and publications bounded while scrolling %i long files',
    async (files) => {
      const owner = new CombinedDiffViewportOwner()
      const unmount = mountViewport(owner)
      const mounted = new Map<DiffViewportItem, () => void>()
      let applications = 0
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
            readHeight: () => 1000,
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
      }
    }
  )
})

it('keeps a live owner after its host becomes empty and mounts again', async () => {
  const owner = new CombinedDiffViewportOwner()
  const release = owner.retain()
  const unmount = mountViewport(owner)
  owner.setItems(inputs(1))
  await commit()
  // Detach only the temporary host; owner lifetime belongs to its hook lease.
  const host = document.createElement('div')
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } })
  const detach = owner.mount(host)
  detach()
  owner.setItems([])
  await commit()
  const again = owner.mount(host)
  owner.setItems(inputs(2))
  await commit()
  expect(owner.getSnapshot().map((item) => item.key)).toEqual(['file-0'])
  expect(owner.getLayout().logicalHeight).toBe(2000)
  again()
  release()
  unmount()
})

it('retains a focused nontext control offscreen and releases it when focus leaves', async () => {
  const owner = new CombinedDiffViewportOwner()
  const unmount = mountViewport(owner)
  owner.setItems(inputs(3))
  await commit()
  const item = owner.getSnapshot()[0]
  const node = document.createElement('div')
  const retry = document.createElement('button')
  node.append(retry)
  owner.scene.append(node)
  owner.setNode(item, node)
  retry.focus()
  await commit()
  retry.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })
  )
  retry.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })
  )
  expect(owner.getScrollTop()).toBe(1000)
  expect(document.activeElement).toBe(retry)
  expect(owner.getSnapshot().map((row) => row.key)).toEqual(['file-0', 'file-1'])
  owner.root.focus()
  await commit()
  expect(owner.getSnapshot().map((row) => row.key)).toEqual(['file-1'])
  owner.setNode(item, null)
  node.remove()
  unmount()
})

it.each([200, 2000])(
  'skips sibling estimates for a local update among %i sections',
  async (files) => {
    const owner = new CombinedDiffViewportOwner()
    const unmount = mountViewport(owner)
    const adapter = new CombinedDiffInputs(owner)
    const section: DiffSection = {
      key: 'file-0',
      path: 'a.ts',
      status: 'modified',
      originalContent: 'a',
      modifiedContent: 'b',
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null
    }
    let siblingContentReads = 0
    const sections = Array.from({ length: files }, (_, index) => {
      const value = { ...section, key: `file-${index}` }
      Object.defineProperty(value, 'originalContent', {
        get: () => {
          siblingContentReads++
          return 'a'
        }
      })
      return value
    })
    const heights = {}
    adapter.update(sections, heights, false)
    await commit()
    owner.measure(owner.getItem('file-0')!, 1000)
    await commit()
    const publications = vi.fn()
    const unsubscribe = owner.subscribeScroll(publications)
    const rebuild = vi.spyOn(CombinedDiffExtentIndex.prototype, 'rebuildSuffix')
    const dirty = [...sections]
    dirty[0] = { ...section, modifiedContent: 'bc', dirty: true }
    siblingContentReads = 0
    adapter.update(sections, heights, false)
    adapter.update(dirty, heights, false)
    expect(siblingContentReads).toBe(0)
    // Repeating the opaque snapshot still leaves the unaffected body estimates alone.
    adapter.update(dirty, { ...heights }, false)
    expect(siblingContentReads).toBe(0)
    await commit()
    expect(rebuild).not.toHaveBeenCalled()
    expect(publications).not.toHaveBeenCalled()
    const collapsed = [...dirty]
    collapsed[0] = { ...dirty[0], collapsed: true }
    adapter.update(collapsed, heights, false)
    expect(siblingContentReads).toBe(0)
    await commit()
    expect(owner.getLayout().logicalHeight).toBe((files - 1) * 88 + 28)
    expect(rebuild).toHaveBeenCalledTimes(1)
    rebuild.mockRestore()
    unsubscribe()
    unmount()
  }
)
