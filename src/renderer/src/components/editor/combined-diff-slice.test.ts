// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { getCombinedDiffExtent } from './combined-diff-extent-dom'
import { installCombinedDiffSlice } from './combined-diff-slice'
import {
  getCombinedDiffCodeRect,
  getCombinedDiffSlice,
  resolveCombinedDiffReveal
} from './combined-diff-slice-geometry'
import { revealCombinedDiffTarget, scrollCombinedDiffBy } from './combined-diff-navigation'

function signal<T>() {
  const listeners = new Set<(event: T) => void>()
  return {
    event: (listener: (event: T) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (event: T) => listeners.forEach((listener) => listener(event))
  }
}

function fixture() {
  const viewport = document.createElement('div')
  viewport.dataset.combinedDiffViewport = ''
  const row = document.createElement('div')
  row.dataset.combinedDiffSectionRow = ''
  row.dataset.index = '1'
  let prefix = 568
  row.getBoundingClientRect = () => new DOMRect(0, prefix - viewport.scrollTop, 800, 3832)
  const header = document.createElement('div')
  header.dataset.combinedDiffSectionHeader = ''
  header.getBoundingClientRect = () => new DOMRect(0, 0, 800, 32)
  const body = document.createElement('div')
  body.getBoundingClientRect = () => new DOMRect(0, prefix + 32 - viewport.scrollTop, 800, 3800)
  const host = document.createElement('section')
  const root = document.createElement('div')
  host.append(root)
  body.append(host)
  row.append(header, body)
  viewport.append(row)
  document.body.append(viewport)
  let scrollHeight = 10000
  let contentHeight = 3800
  Object.defineProperties(viewport, {
    clientHeight: { value: 700 },
    clientWidth: { value: 800 },
    scrollHeight: { get: () => scrollHeight }
  })
  Object.defineProperty(body, 'clientWidth', { value: 800 })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 700)
  let top = 0
  let writes = 0
  Object.defineProperty(viewport, 'scrollTop', {
    get: () => top,
    set: (value) => {
      top = value
      writes += 1
    }
  })
  const model = { uri: 'fixture' }
  const makePane = (padding: number) => {
    let scroll = padding
    const reveal = signal<editor.IEditorRevealRequest>()
    const change = signal<{ scrollTop: number; scrollTopChanged: boolean }>()
    const size = signal<void>()
    const replaced = signal<void>()
    const node = document.createElement('div')
    root.append(node)
    const pane = {
      getModel: () => model,
      getContainerDomNode: () => node,
      getContentHeight: () => contentHeight,
      getScrollTop: () => scroll,
      setScrollTop: (value: number) => {
        scroll = value + padding
        change.fire({ scrollTop: scroll, scrollTopChanged: true })
      },
      onDidRequestReveal: reveal.event,
      onDidScrollChange: change.event,
      onDidContentSizeChange: size.event,
      onDidChangeHiddenAreas: size.event,
      onDidChangeViewZones: size.event,
      onDidLayoutChange: size.event,
      onDidChangeModel: replaced.event
    }
    return {
      pane,
      reveal,
      change,
      size,
      replaced,
      set: (value: number) => {
        scroll = value
      }
    }
  }
  const original = makePane(19)
  const modified = makePane(0)
  const layout = vi.fn(() => {
    original.change.fire({ scrollTop: 200000, scrollTopChanged: true })
    modified.size.fire()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this controller test supplies every diff/pane member the controller calls.
  const diff = {
    getContainerDomNode: () => root,
    getOriginalEditor: () => original.pane,
    getModifiedEditor: () => modified.pane,
    layout
  } as unknown as editor.IStandaloneDiffEditor
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  const owner = getCombinedDiffExtent(viewport)
  const publish = () =>
    owner.publish([
      { key: 'prefix', index: 0, lane: 0, start: 0, size: prefix, end: prefix },
      {
        key: 'file',
        index: 1,
        lane: 0,
        start: prefix,
        size: contentHeight + 32,
        end: prefix + contentHeight + 32
      },
      {
        key: 'tail',
        index: 2,
        lane: 0,
        start: prefix + contentHeight + 32,
        size: scrollHeight - prefix - contentHeight - 32,
        end: scrollHeight
      }
    ])
  publish()
  const publishExtent = vi.fn((height: number) => {
    scrollHeight = 6200 + height
    publish()
  })
  const dispose = installCombinedDiffSlice(diff, body, publishExtent)
  const request = (source = 'api', policy = 2) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: identity is all the resolver reads from the model; geometry is supplied by the patched event.
    modified.reveal.fire({
      kind: 'range',
      model: model as unknown as editor.ITextModel,
      source,
      minimal: source === 'mouse',
      top: 361,
      bottom: 380,
      verticalType: policy
    })
  }
  return {
    viewport,
    body,
    host,
    original,
    modified,
    layout,
    dispose,
    request,
    model,
    publishExtent,
    owner,
    growPrefix: (amount: number) => {
      prefix += amount
      scrollHeight += amount
      publish()
    },
    setContentHeight: (value: number) => {
      contentHeight = value
    },
    writes: () => writes
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('publishes expanded extent before preserving the lower anchor, independent of pane scroll baselines', async () => {
  const f = fixture()
  f.viewport.scrollTop = 3700
  f.viewport.dispatchEvent(new Event('scroll'))
  f.setContentHeight(4200)
  f.original.set(400)
  f.modified.set(381)
  f.original.change.fire({ scrollTop: 400, scrollTopChanged: true })
  f.modified.change.fire({ scrollTop: 381, scrollTopChanged: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this model's identity participates in the anchor contract.
  f.original.reveal.fire({
    kind: 'anchor',
    model: f.model as unknown as editor.ITextModel,
    delta: 400
  })
  await Promise.resolve()
  expect(f.publishExtent).toHaveBeenCalledWith(4200)
  expect(f.viewport.scrollTop).toBe(4100)
  expect(f.writes()).toBe(2)
  f.dispose()
})

it('keeps a screen-sized cap for a partial following file and uses actual visible code edges', () => {
  expect(getCombinedDiffSlice(3800, 700, 32, 600, 0)).toEqual({ height: 668, offset: 0 })
  expect(getCombinedDiffSlice(3800, 700, 32, 600, 1000)).toEqual({ height: 668, offset: 432 })
  expect(getCombinedDiffSlice(60, 700, 32, 600, 1000)).toEqual({ height: 60, offset: 0 })
  const f = fixture()
  const node = f.modified.pane.getContainerDomNode()
  node.getBoundingClientRect = () => new DOMRect(0, 600, 800, 668)
  expect(getCombinedDiffCodeRect(node).bottom).toBe(700)
  expect(f.host.style.height).toBe('668px')
  f.dispose()
})

it('reveals an unchanged sole match once despite paired local scroll and unequal pane baselines', async () => {
  const f = fixture()
  f.original.set(919)
  f.modified.set(900)
  f.request()
  f.original.change.fire({ scrollTop: 919, scrollTopChanged: true })
  f.modified.change.fire({ scrollTop: 900, scrollTopChanged: true })
  await Promise.resolve()
  expect(f.writes()).toBe(1)
  expect(f.viewport.scrollTop).toBeGreaterThan(600)
  const target = 961 - f.viewport.scrollTop
  expect(target).toBeGreaterThanOrEqual(32)
  expect(target + 19).toBeLessThanOrEqual(700)
  f.request()
  await Promise.resolve()
  expect(f.writes()).toBe(1)
  f.dispose()
})

it('uses the same resolver for comments and edge drag, and discards stale work on manual input and teardown', async () => {
  const f = fixture()
  f.request()
  f.viewport.dispatchEvent(new Event('wheel'))
  await Promise.resolve()
  expect(f.writes()).toBe(0)
  const node = f.modified.pane.getContainerDomNode()
  expect(revealCombinedDiffTarget(node, 361, 380)).toBe(true)
  expect(f.writes()).toBe(1)
  const before = f.viewport.scrollTop
  expect(scrollCombinedDiffBy(node, 24)).toBe(true)
  expect(f.viewport.scrollTop).toBe(before + 24)
  f.request('keyboard')
  f.dispose()
  await Promise.resolve()
  expect(f.writes()).toBe(2)
  expect(scrollCombinedDiffBy(node, 24)).toBeUndefined()
})

it('treats mouse/restore requests and transaction-owned layout as acknowledgements', async () => {
  const f = fixture()
  // A visible click intersects the true viewport even though its line is clipped at the edge.
  expect(resolveCombinedDiffReveal(0, 700, 32, 690, 709, 0, true)).toBe(0)
  f.request('restoreState')
  await Promise.resolve()
  expect(f.writes()).toBe(0)
  expect(f.layout).toHaveBeenCalledTimes(1)
  f.original.change.fire({ scrollTop: f.original.pane.getScrollTop(), scrollTopChanged: true })
  await Promise.resolve()
  expect(f.writes()).toBe(0)
  f.dispose()
})

it('reveals only the requested Find chrome, including an already-open expanded Replace', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the event only compares this model identity.
  const model = f.model as unknown as editor.ITextModel
  f.modified.reveal.fire({ kind: 'find', model, height: 33 })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes()).toBe(0)
  f.body.getBoundingClientRect = () => new DOMRect(0, 690 - f.viewport.scrollTop, 800, 3800)
  f.modified.reveal.fire({ kind: 'find', model, height: 62 })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(52)
  f.viewport.scrollTop = 0
  f.modified.reveal.fire({ kind: 'find', model, height: 62 })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(52)
  f.dispose()
})

it('does not reverse extent changes and does not lose newer input in an invalidated microtask', async () => {
  const f = fixture()
  f.modified.change.fire({ scrollTop: 400, scrollTopChanged: true })
  f.modified.size.fire()
  await Promise.resolve()
  expect(f.writes()).toBe(0)
  f.request()
  f.viewport.dispatchEvent(new Event('wheel'))
  f.request()
  await Promise.resolve()
  await Promise.resolve()
  expect(f.writes()).toBe(1)
  f.dispose()
})

it('restores the exact outer position on go-to cancellation, including the non-injective following slice', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this event needs only the model identity; Monaco creates the view-state object in production.
  const model = f.model as unknown as editor.ITextModel
  const state: editor.ICodeEditorViewState = {
    cursorState: [],
    viewState: {
      scrollLeft: 0,
      firstPosition: { lineNumber: 1, column: 1 },
      firstPositionDeltaTop: 0
    },
    contributionsState: {}
  }
  f.modified.reveal.fire({ kind: 'save', model, state })
  f.request()
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBeGreaterThan(600)
  f.modified.set(0)
  f.modified.change.fire({ scrollTop: 0, scrollTopChanged: true })
  f.modified.reveal.fire({ kind: 'restore', model, state })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes()).toBe(2)
  const restored = { ...state }
  f.viewport.scrollTop = 120
  f.modified.reveal.fire({ kind: 'restore', model, state: restored })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(120)
  f.growPrefix(200)
  f.modified.set(0)
  f.modified.reveal.fire({ kind: 'restore', model, state })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(200)
  f.dispose()
})

it('keeps an already-visible Find surface at its current logical offset inside a long file', async () => {
  const f = fixture()
  f.viewport.scrollTop = 1000
  f.viewport.dispatchEvent(new Event('scroll'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this event needs only the model identity.
  const model = f.model as unknown as editor.ITextModel
  const before = f.writes()
  f.modified.reveal.fire({ kind: 'find', model, height: 33 })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(1000)
  expect(f.writes()).toBe(before)
  f.dispose()
})

it('bounds comment dragging to its file when another file follows', () => {
  const f = fixture()
  const node = f.modified.pane.getContainerDomNode()
  expect(scrollCombinedDiffBy(node, 24)).toBe(true)
  expect(f.viewport.scrollTop).toBe(24)
  f.viewport.scrollTop = 3700
  expect(scrollCombinedDiffBy(node, 24)).toBe(false)
  expect(f.viewport.scrollTop).toBe(3700)
  f.viewport.scrollTop = 568
  expect(scrollCombinedDiffBy(node, -24)).toBe(false)
  expect(f.viewport.scrollTop).toBe(568)
  f.dispose()
})

it('maps original-pane reveal coordinates through its own unequal scroll baseline', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only model identity is used by this request.
  const model = f.model as unknown as editor.ITextModel
  // Original padding is 19px; its 100..119 target is already visible at outer 681..700.
  f.original.reveal.fire({
    kind: 'range',
    model,
    source: 'api',
    minimal: false,
    top: 100,
    bottom: 119,
    verticalType: 0
  })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(0)
  expect(f.writes()).toBe(0)
  expect(revealCombinedDiffTarget(f.original.pane.getContainerDomNode(), 100, 119, 0)).toBe(true)
  expect(f.writes()).toBe(0)
  f.dispose()
})

it('keeps the restored file anchor when a virtualized predecessor publishes after Escape', async () => {
  const f = fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this event compares model identity only.
  const model = f.model as unknown as editor.ITextModel
  const state: editor.ICodeEditorViewState = {
    cursorState: [],
    viewState: {
      scrollLeft: 0,
      firstPosition: { lineNumber: 1, column: 1 },
      firstPositionDeltaTop: 0
    },
    contributionsState: {}
  }
  f.modified.reveal.fire({ kind: 'save', model, state })
  f.request()
  await Promise.resolve()
  f.modified.set(0)
  f.modified.reveal.fire({ kind: 'restore', model, state })
  await Promise.resolve()
  expect(f.viewport.scrollTop).toBe(0)
  f.growPrefix(200)
  expect(f.viewport.scrollTop).toBe(200)
  f.dispose()
})
