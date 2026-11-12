// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import { CombinedDiffInputs } from './combined-diff-inputs'
import type { DiffSection } from '../../diff/sections/diff-section-types'
import { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'

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

describe('combined diff viewport publication', () => {
  it('retains a restore at zero height until authoritative absence retires it without mounting', async () => {
    const owner = new CombinedDiffViewportOwner()
    const view = { scrollAnchor: { key: 'file-1', offset: 200 }, scrollTop: 1200 }
    try {
      owner.setItems(inputs(3).map((item) => ({ ...item, bodyKind: 'pending' as const })))
      owner.importView(view.scrollAnchor, view.scrollTop)
      await commit()
      expect(owner.getViewMemory()).toEqual(view)
      owner.setItems([], false)
      await commit()
      expect(owner.getViewMemory()).toEqual(view)
      owner.setItems([], true)
      await commit()
      expect(owner.getViewMemory()).toEqual({ scrollAnchor: null, scrollTop: 0 })
    } finally {
      owner.dispose()
    }
  })

  it('keeps a restore through temporary empty materialization but retires it when an unmounted collection is actually empty', async () => {
    const owner = new CombinedDiffViewportOwner()
    const host = document.createElement('div')
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 500 } })
    document.body.append(host)
    const unmount = owner.mount(host)
    const view = { scrollAnchor: { key: 'file-1', offset: 200 }, scrollTop: 1200 }
    const rows = inputs(3).map((item) => ({ ...item, bodyKind: 'pending' as const }))
    try {
      owner.setItems(rows)
      owner.importView(view.scrollAnchor, view.scrollTop)
      await commit()
      unmount()
      owner.setItems([], false)
      await commit()
      expect(owner.getViewMemory()).toEqual(view)
      owner.setItems([], true)
      await commit()
      expect(owner.getViewMemory()).toEqual({ scrollAnchor: null, scrollTop: 0 })
      owner.setItems(rows)
      const detach = owner.mount(host)
      await commit()
      expect(owner.getScrollTop()).toBe(0)
      detach()
    } finally {
      unmount()
      owner.dispose()
      host.remove()
    }
  })

  it('lets a direct wheel clamped at a provisional boundary supersede the saved restore', async () => {
    const owner = new CombinedDiffViewportOwner()
    const unmount = mountViewport(owner)
    const target = { key: 'target', generation: '1', collapsed: false, index: 0 }
    try {
      owner.setItems([{ ...target, height: 88, bodyKind: 'pending' }])
      owner.importView({ key: 'target', offset: 1000 }, 1000)
      await commit()
      owner.root.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })
      )
      owner.setItems([{ ...target, height: 2000, bodyKind: 'final' }])
      owner.measure(owner.getItem('target')!, 2000)
      await commit()
      expect(owner.getScrollTop()).toBe(0)
      expect(owner.getViewMemory().scrollAnchor).toEqual({ key: 'target', offset: 0 })
    } finally {
      unmount()
    }
  })

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
