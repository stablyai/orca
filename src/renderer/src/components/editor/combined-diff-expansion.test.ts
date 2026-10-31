// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { installCombinedDiffSlice } from './combined-diff-slice'
import { getCombinedDiffExtent } from './combined-diff-extent-dom'

function fixture(deferred = false) {
  const viewport = document.createElement('div')
  viewport.dataset.combinedDiffViewport = ''
  const row = document.createElement('div')
  row.dataset.combinedDiffSectionRow = ''
  row.dataset.index = '0'
  const header = document.createElement('div')
  header.dataset.combinedDiffSectionHeader = ''
  const body = document.createElement('div')
  const host = document.createElement('div')
  const root = document.createElement('div')
  host.append(root)
  body.append(host)
  row.append(header, body)
  viewport.append(row)
  document.body.append(viewport)
  let outer = 48382
  let rowHeight = 640
  let nativeHeight = 564
  let lineTop = 24
  let requestedHeight = 0
  let disposed = false
  const writes: number[] = []
  const listeners = new Set<() => void>()
  const modelListeners = new Set<() => void>()
  const observers: (() => void)[] = []
  const frames: FrameRequestCallback[] = []
  const sourceModel = { getLineCount: () => 100 }
  let model: typeof sourceModel | null = sourceModel
  Object.defineProperties(viewport, {
    clientHeight: { value: 821 },
    scrollHeight: { value: 63697 },
    scrollTop: {
      get: () => outer,
      set: (value) => {
        outer = value
        writes.push(value)
      }
    }
  })
  Object.defineProperty(body, 'clientWidth', { value: 1305 })
  header.getBoundingClientRect = () => new DOMRect(0, 0, 1305, 36)
  row.getBoundingClientRect = () => new DOMRect(0, 48382 - outer, 1305, rowHeight)
  body.getBoundingClientRect = () => new DOMRect(0, 48418 - outer, 1305, rowHeight - 37)
  const makePane = (scrollbar: number) => {
    let scroll = 0
    let cap = 584
    let handler: ((request: editor.IEditorScrollAnchorRequest) => void) | undefined
    const changed = new Set<(event: object) => void>()
    const reveals = new Set<(event: object) => void>()
    const node = document.createElement('div')
    root.append(node)
    const content = () => nativeHeight + scrollbar
    const signal = (callback: () => void) => {
      listeners.add(callback)
      return { dispose: () => listeners.delete(callback) }
    }
    const pane = {
      getModel: () => model,
      getContainerDomNode: () => node,
      getContentHeight: content,
      getTopForLineNumber: () => lineTop,
      getScrollTop: () => scroll,
      setScrollTop: (target: number, _type?: number, scrollSource?: string) => {
        const before = scroll
        scroll = Math.max(0, Math.min(target, content() - cap))
        changed.forEach((callback) =>
          callback({
            scrollTop: scroll,
            scrollTopChanged: scroll !== before,
            scrollTopDelta: scroll - before,
            scrollSource
          })
        )
      },
      setScrollAnchorHandler: (next: typeof handler) => {
        handler = next
        return {
          dispose: () => {
            handler = undefined
          }
        }
      },
      onDidRequestReveal: (callback: (event: object) => void) => {
        reveals.add(callback)
        return { dispose: () => reveals.delete(callback) }
      },
      onDidScrollChange: (callback: (event: object) => void) => {
        changed.add(callback)
        return { dispose: () => changed.delete(callback) }
      },
      onDidContentSizeChange: signal,
      onDidChangeHiddenAreas: signal,
      onDidChangeViewZones: signal,
      onDidLayoutChange: signal,
      onDidChangeModel: (callback: () => void) => {
        modelListeners.add(callback)
        return { dispose: () => modelListeners.delete(callback) }
      }
    }
    return {
      pane,
      cap: (value: number) => {
        cap = value
        pane.setScrollTop(scroll, 1, 'geometry')
      },
      baseline: (value: number) => {
        const before = scroll
        scroll = value
        changed.forEach((callback) =>
          callback({
            scrollTop: scroll,
            scrollTopChanged: true,
            scrollTopDelta: scroll - before,
            scrollSource: 'geometry'
          })
        )
      },
      expand: (update: () => void, lineNumber = 38) => {
        if (handler) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the request's model identity and line-count API.
          handler({ model: sourceModel as unknown as editor.ITextModel, lineNumber, update })
        } else {
          const before = lineTop
          update()
          pane.setScrollTop(scroll + lineTop - before)
          reveals.forEach((callback) =>
            callback({ kind: 'anchor', model: sourceModel, delta: lineTop - before })
          )
        }
      }
    }
  }
  const original = makePane(20)
  const modified = makePane(0)
  const syncModified = modified.pane.setScrollTop
  modified.pane.setScrollTop = (value, type, source) => {
    original.pane.setScrollTop(value, type, source)
    syncModified(value, type, source)
  }
  const owner = getCombinedDiffExtent(viewport)
  const publish = () =>
    owner.publish([
      { key: 'file', index: 0, lane: 0, start: 48382, end: 48382 + rowHeight, size: rowHeight },
      {
        key: 'tail',
        index: 1,
        lane: 0,
        start: 48382 + rowHeight,
        end: 63057 + rowHeight,
        size: 14675
      }
    ])
  publish()
  const ack = () => {
    rowHeight = requestedHeight + 56
    publish()
    observers.forEach((callback) => callback())
    frames.splice(0).forEach((callback) => callback(0))
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every diff and pane member used by the installed slice.
  const diff = {
    getContainerDomNode: () => root,
    getOriginalEditor: () => original.pane,
    getModifiedEditor: () => modified.pane,
    layout: ({ height }: { height: number }) => {
      original.cap(height)
      modified.cap(height)
      listeners.forEach((callback) => callback())
    }
  } as unknown as editor.IStandaloneDiffEditor
  const publishExtent = vi.fn((height: number) => {
    requestedHeight = height
    if (!deferred) {
      rowHeight = height + 56
      publish()
    }
  })
  const cleanup = installCombinedDiffSlice(diff, body, publishExtent)
  writes.length = 0
  return {
    original,
    modified,
    owner,
    viewport,
    writes,
    ack,
    publishExtent,
    point: (pane = modified.pane) =>
      36 + Number.parseFloat(host.style.top || '0') + lineTop - pane.getScrollTop() + 48382 - outer,
    update: () => {
      nativeHeight += 360
      lineTop += 360
      listeners.forEach((callback) => callback())
    },
    replace: () => {
      model = null
      modelListeners.forEach((callback) => callback())
    },
    dispose: () => {
      if (!disposed) {
        disposed = true
        cleanup()
      }
    }
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it.each(['original', 'modified'] as const)(
  'preserves the actual lower %s line across the R5 cap crossing and pane scroll clamp',
  async (side) => {
    const f = fixture()
    const selected = f[side]
    f.original.baseline(19)
    const before = f.point(selected.pane)
    selected.expand(f.update)
    await Promise.resolve()
    expect(f.point(selected.pane)).toBe(before)
    expect(f.writes).toHaveLength(1)
    expect(f.point(selected.pane)).toBe(before)
    f.dispose()
  }
)

it('waits for the current row publication, then consumes one transaction and retains an ordinary numeric point', async () => {
  const f = fixture(true)
  f.modified.expand(f.update)
  await Promise.resolve()
  expect(f.writes).toEqual([])
  f.ack()
  expect(f.point()).toBe(60)
  expect(f.writes).toEqual([48742])
  const saved = f.owner.exportView()
  f.ack()
  expect(f.owner.exportView()).toEqual(saved)
  expect(f.writes).toEqual([48742])
  f.dispose()
})

it.each(['input', 'model', 'dispose'] as const)(
  'runs the change once but retires deferred geometry on %s',
  async (reason) => {
    const f = fixture(true)
    const update = vi.fn(f.update)
    f.modified.expand(update)
    if (reason === 'input') {
      f.viewport.dispatchEvent(new Event('wheel'))
      f.owner.input()
    }
    if (reason === 'model') {
      f.replace()
    }
    if (reason === 'dispose') {
      f.dispose()
    }
    f.ack()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    expect(f.writes).toEqual([])
    f.dispose()
  }
)

it('retires a claimed expansion when publication disposes the binding and repeats each live change once', () => {
  const f = fixture()
  const update = vi.fn(f.update)
  f.modified.expand(update)
  f.modified.expand(update)
  expect(update).toHaveBeenCalledTimes(2)
  expect(f.point()).toBe(60)
  expect(f.writes).toEqual([48742, 49102])
  f.publishExtent.mockImplementation(() => f.dispose())
  f.modified.expand(update)
  expect(update).toHaveBeenCalledTimes(3)
  expect(f.writes).toEqual([48742, 49102])
})
