// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'
import { observeCombinedDiffRowContent } from './combined-diff-row-chrome'

it('rebinds retained content after an earlier row disappears and ignores retired observations', async () => {
  const mutations: { callback: () => void; node?: Node }[] = []
  const resizes: { callback: () => void; nodes: Element[] }[] = []
  vi.stubGlobal(
    'MutationObserver',
    class {
      entry: (typeof mutations)[number]
      constructor(callback: () => void) {
        this.entry = { callback }
        mutations.push(this.entry)
      }
      observe(node: Node): void {
        this.entry.node = node
      }
      disconnect(): void {}
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: (typeof resizes)[number]
      constructor(callback: () => void) {
        this.entry = { callback, nodes: [] }
        resizes.push(this.entry)
      }
      observe(node: Element): void {
        this.entry.nodes.push(node)
      }
      disconnect(): void {}
    }
  )
  const owner = new CombinedDiffViewportOwner()
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { value: 800 },
    clientHeight: { value: 500 }
  })
  const unmount = owner.mount(host)
  const commit = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const a = { key: 'a', generation: 'deferred', height: 200, collapsed: false, index: 0 }
  const b = { ...a, key: 'b', index: 1 }
  owner.setItems([a, b])
  const item = owner.getItem('b')!
  const row = document.createElement('div')
  const wrapper = (): { content: HTMLDivElement; header: HTMLDivElement } => {
    const content = document.createElement('div')
    const header = document.createElement('div')
    header.setAttribute('data-combined-diff-section-header', '')
    content.append(header)
    return { content, header }
  }
  const old = wrapper()
  let oldHeight = 200
  Object.defineProperty(old.content, 'offsetHeight', { get: () => oldHeight })
  row.append(old.content)
  const stop = observeCombinedDiffRowContent(item, row)
  try {
    const stale = resizes.filter(
      ({ nodes }) => nodes.includes(old.content) || nodes.includes(old.header)
    )
    const rootMutation = mutations.find(({ node }) => node === row)!.callback
    owner.setItems([{ ...b, index: 0 }])
    expect(owner.getItem('b')).toBe(item)
    row.replaceChildren()
    oldHeight = 900
    stale.forEach(({ callback }) => callback())
    await commit()
    expect(owner.getLayout().logicalHeight).toBe(200)
    rootMutation()
    await commit()
    expect(owner.getLayout().logicalHeight).toBe(200)
    const next = wrapper()
    let nextHeight = 320
    Object.defineProperty(next.content, 'offsetHeight', { get: () => nextHeight })
    row.append(next.content)
    rootMutation()
    await commit()
    expect(item.chrome.header).toBe(next.header)
    expect(owner.getLayout().logicalHeight).toBe(320)
    oldHeight = 900
    stale.forEach(({ callback }) => callback())
    await commit()
    expect(item.chrome.header).toBe(next.header)
    expect(owner.getLayout().logicalHeight).toBe(320)
    nextHeight = 400
    resizes.find(({ nodes }) => nodes.includes(next.content))!.callback()
    await commit()
    expect(owner.getLayout().logicalHeight).toBe(400)
    owner.updateItems([{ ...b, index: 0, bodyKind: 'native' }])
    nextHeight = 80
    resizes.find(({ nodes }) => nodes.includes(next.content))!.callback()
    await commit()
    expect(owner.getLayout().logicalHeight).toBe(400)
    stop()
    stale.forEach(({ callback }) => callback())
    resizes.forEach(({ callback }) => callback())
    await commit()
    expect(item.chrome.header).toBeNull()
    expect(owner.getLayout().logicalHeight).toBe(400)
  } finally {
    stop()
    unmount()
    owner.dispose()
    vi.unstubAllGlobals()
  }
})
