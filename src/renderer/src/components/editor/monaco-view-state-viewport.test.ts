// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { editorSelectionCache, editorViewStateCache, scrollTopCache } from '@/lib/scroll-cache'
import { restoreMonacoViewState, snapshotMonacoViewState } from './monaco-view-state-persistence'

const frames = new Map<number, FrameRequestCallback>()
const cleanups: (() => void)[] = []
const canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
let nextFrame = 0

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      webkitBackingStorePixelRatio: 1,
      measureText: (text: string) => ({ width: text.length * 8 }),
      clearRect: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {}
    })
  })
})
afterAll(() => {
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', canvasContext)
  }
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  frames.clear()
  editorSelectionCache.clear()
  editorViewStateCache.clear()
  scrollTopCache.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function createEditor(width = 800) {
  const container = document.createElement('div')
  document.body.append(container)
  const model = monaco.editor.createModel(
    Array.from(
      { length: 100 },
      () => 'The viewport anchor preserves this long line through wrapping and pane resizing.'
    ).join('\n'),
    'plaintext'
  )
  const instance = monaco.editor.create(container, {
    model,
    dimension: { width, height: 300 },
    automaticLayout: false,
    wordWrap: 'on',
    minimap: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false
  })
  cleanups.push(() => {
    instance.dispose()
    model.dispose()
    container.remove()
  })
  return { instance, model }
}
function pauseFrames() {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const frame = ++nextFrame
    frames.set(frame, callback)
    return frame
  })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame))
}
function flushFrames() {
  const queued = [...frames]
  frames.clear()
  queued.forEach(([, callback]) => callback(0))
}
function subscriptions(instance: monaco.editor.IStandaloneCodeEditor) {
  const spies = [vi.spyOn(instance, 'onDidDispose'), vi.spyOn(instance, 'onDidChangeModel')]
  return () =>
    spies.map((subscribe) => {
      const subscription = subscribe.mock.results[0]
      if (subscription?.type !== 'return') {
        throw new Error('Expected a restore subscription')
      }
      return vi.spyOn(subscription.value, 'dispose')
    })
}

describe('real Monaco native viewport restoration', () => {
  it.each([0, 120, 120.5])(
    'preserves viewport and backwards selection through %ipx initial layout and growth',
    (width) => {
      const source = createEditor()
      source.instance.setSelection(new monaco.Selection(80, 7, 75, 2))
      source.instance.setScrollTop(1200)
      source.instance.render()
      snapshotMonacoViewState({ current: source.instance }, 'file.ts::pane-a')
      const target = createEditor(width)
      const restore = vi.spyOn(target.instance, 'restoreViewState')
      const scroll = vi.spyOn(target.instance, 'setScrollTop')
      const focus = vi.spyOn(target.instance, 'focus')
      const trackSubscriptions = subscriptions(target.instance)
      pauseFrames()
      restoreMonacoViewState(target.instance, 'file.ts::pane-a')
      const unsubscribe = trackSubscriptions()
      flushFrames()
      target.instance.render()
      expect(restore).toHaveBeenCalledOnce()
      expect(scroll).not.toHaveBeenCalled()
      target.instance.layout({ width: 800, height: 300 })
      expect(target.instance.getScrollTop()).toBe(source.instance.getScrollTop())
      expect(target.instance.getSelection()).toEqual(source.instance.getSelection())
      expect(focus).toHaveBeenCalledOnce()
      unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
      expect(frames.size).toBe(0)
      expect(target.instance.getModel()).toBe(target.model)
    }
  )

  it('cancels a hidden editor before its restore frame', () => {
    const source = createEditor()
    snapshotMonacoViewState({ current: source.instance }, 'file.ts')
    const target = createEditor(0)
    const restore = vi.spyOn(target.instance, 'restoreViewState')
    const trackSubscriptions = subscriptions(target.instance)
    pauseFrames()
    restoreMonacoViewState(target.instance, 'file.ts')
    const unsubscribe = trackSubscriptions()
    target.instance.dispose()
    flushFrames()
    expect(frames.size).toBe(0)
    unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    expect(restore).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'rejects an old model after disposal=%s or replacement',
    (disposeModel) => {
      const source = createEditor()
      snapshotMonacoViewState({ current: source.instance }, 'file.ts')
      const target = createEditor(0)
      const restore = vi.spyOn(target.instance, 'restoreViewState')
      const focus = vi.spyOn(target.instance, 'focus')
      const trackSubscriptions = subscriptions(target.instance)
      pauseFrames()
      restoreMonacoViewState(target.instance, 'file.ts')
      const unsubscribe = trackSubscriptions()
      if (disposeModel) {
        target.model.dispose()
      } else {
        target.instance.setModel(null)
      }
      target.instance.layout({ width: 800, height: 300 })
      flushFrames()
      expect(restore).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      unsubscribe.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    }
  )

  it('restores only the final A in a rapid A to B to A switch', () => {
    const first = createEditor(0)
    const second = createEditor(0)
    const last = createEditor()
    snapshotMonacoViewState({ current: last.instance }, 'a.ts')
    snapshotMonacoViewState({ current: second.instance }, 'b.ts')
    const firstFocus = vi.spyOn(first.instance, 'focus')
    const secondFocus = vi.spyOn(second.instance, 'focus')
    const lastRestore = vi.spyOn(last.instance, 'restoreViewState')
    pauseFrames()
    restoreMonacoViewState(first.instance, 'a.ts')
    restoreMonacoViewState(second.instance, 'b.ts')
    const staleFrames = [...frames.values()]
    first.instance.dispose()
    second.instance.dispose()
    restoreMonacoViewState(last.instance, 'a.ts')
    staleFrames.forEach((callback) => callback(0))
    flushFrames()
    expect(firstFocus).not.toHaveBeenCalled()
    expect(secondFocus).not.toHaveBeenCalled()
    expect(lastRestore).toHaveBeenCalledOnce()
  })

  it('keeps same-file pane state and model identity separate', () => {
    const first = createEditor()
    const sibling = createEditor()
    first.instance.setSelection(new monaco.Selection(80, 7, 75, 2))
    first.instance.setScrollTop(1200)
    sibling.instance.setScrollTop(600)
    snapshotMonacoViewState({ current: first.instance }, 'file.ts::pane-a')
    snapshotMonacoViewState({ current: sibling.instance }, 'file.ts::pane-b')
    first.instance.setScrollTop(0)
    sibling.instance.setScrollTop(0)
    pauseFrames()
    restoreMonacoViewState(first.instance, 'file.ts::pane-a')
    restoreMonacoViewState(sibling.instance, 'file.ts::pane-b')
    flushFrames()
    expect(first.instance.getSelection()).toEqual(new monaco.Selection(80, 7, 75, 2))
    expect(first.instance.getScrollTop()).toBe(1200)
    expect(sibling.instance.getScrollTop()).toBe(600)
    expect(first.instance.getModel()).toBe(first.model)
    expect(sibling.instance.getModel()).toBe(sibling.model)
    expect(first.model.canUndo()).toBe(false)
  })

  it('bounds native view states with the existing working-set limit', () => {
    const source = createEditor()
    for (let index = 0; index < 25; index++) {
      snapshotMonacoViewState({ current: source.instance }, `file-${index}.ts`)
    }
    expect(editorViewStateCache.size).toBe(20)
    expect(editorViewStateCache.has('file-0.ts')).toBe(false)
    expect(editorViewStateCache.has('file-24.ts')).toBe(true)
  })

  it('clamps a stored viewport and selection after file contents shrink', () => {
    const source = createEditor()
    source.instance.setSelection(new monaco.Selection(80, 7, 75, 2))
    source.instance.setScrollTop(1200)
    snapshotMonacoViewState({ current: source.instance }, 'file.ts')
    const target = createEditor()
    target.model.setValue('short')
    pauseFrames()
    restoreMonacoViewState(target.instance, 'file.ts')
    flushFrames()
    expect(target.instance.getSelection()?.positionLineNumber).toBe(1)
    expect(target.instance.getScrollTop()).toBe(0)
    expect(target.instance.getModel()).toBe(target.model)
  })
})
