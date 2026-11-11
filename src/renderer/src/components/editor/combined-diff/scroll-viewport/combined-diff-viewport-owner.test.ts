// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
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
      expect(owner.getLayout().items[1].start - owner.getScrollTop()).toBe(300)
      expect(published).toEqual([1700])
    } finally {
      unsubscribe()
      unmount()
    }
  })

  it.each([20, 200])(
    'keeps native work and publications bounded while scrolling %i long files',
    async (files) => {
      const owner = new CombinedDiffViewportOwner()
      const unmount = mountViewport(owner)
      const mounted = new Map<DiffViewportItem, () => void>()
      let applications = 0
      let publications = 0
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
          const unbind = owner.bind(item, {
            apply: () => {
              applications++
            },
            readHeight: () => 1000,
            capture: () => null,
            hasFocus: () => false,
            detach: () => {}
          })
          mounted.set(item, () => {
            unbind()
            owner.setNode(item, null)
            node.remove()
          })
        }
      }
      const unsubscribe = owner.subscribe(reconcileRows)
      const unsubscribeScroll = owner.subscribeScroll(() => publications++)
      try {
        owner.setItems(inputs(files))
        await commit()
        applications = 0
        publications = 0
        // Native focus/selection scrolling enters through the real scene event listener.
        owner.root.scrollTop = 100
        owner.root.dispatchEvent(new Event('scroll'))
        await commit()
        expect(owner.getScrollTop()).toBe(100)
        expect(publications).toBe(1)
        // Two layout phases, at most two intersecting 1000px rows in a 500px viewport.
        expect(applications).toBeLessThanOrEqual(4)
        expect(mounted.size).toBe(1)
        owner.input(1000)
        await commit()
        expect(owner.getScrollTop()).toBe(1100)
        expect(owner.getSnapshot().map((item) => item.key)).toEqual(['file-1'])
        expect(mounted.size).toBe(1)
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
