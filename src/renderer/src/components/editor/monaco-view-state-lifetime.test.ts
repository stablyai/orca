// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { restoreMonacoViewState } from './monaco-view-state-persistence'

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
  scrollTopCache.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function createEditor() {
  const container = document.createElement('div')
  document.body.append(container)
  const model = monaco.editor.createModel('one\ntwo\nthree', 'plaintext')
  const instance = monaco.editor.create(container, {
    model,
    automaticLayout: false,
    minimap: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false
  })
  let disposed = false
  const dispose = () => {
    if (!disposed) {
      disposed = true
      instance.dispose()
      model.dispose()
      container.remove()
    }
  }
  cleanups.push(dispose)
  return { instance, model, dispose }
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
  for (const [frame, callback] of frames) {
    frames.delete(frame)
    callback(0)
  }
}

describe('real Monaco deferred restoration lifetime', () => {
  it('releases all closed editors before paused animation frames resume', () => {
    const editors = Array.from({ length: 40 }, createEditor)
    scrollTopCache.set('closed.ts', 320)
    pauseFrames()
    for (const target of editors) {
      restoreMonacoViewState(target.instance, 'closed.ts')
      target.dispose()
    }

    expect(monaco.editor.getEditors()).toHaveLength(0)
    expect(frames.size).toBe(0)
  })

  it('does not write selection, scroll, or focus after the owning editor closes', () => {
    const target = createEditor()
    const setSelections = vi.spyOn(target.instance, 'setSelections')
    const setScrollTop = vi.spyOn(target.instance, 'setScrollTop')
    const focus = vi.spyOn(target.instance, 'focus')
    editorSelectionCache.set('closed.ts', [new monaco.Selection(3, 4, 2, 1)])
    scrollTopCache.set('closed.ts', 320)
    pauseFrames()
    restoreMonacoViewState(target.instance, 'closed.ts')
    target.dispose()
    flushFrames()

    expect(setSelections).not.toHaveBeenCalled()
    expect(setScrollTop).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })

  it('keeps a surviving editor restore when a sibling closes', () => {
    const closed = createEditor()
    const live = createEditor()
    const selection = new monaco.Selection(3, 4, 2, 1)
    const scroll = vi.spyOn(live.instance, 'setScrollTop')
    const focus = vi.spyOn(live.instance, 'focus')
    const subscribe = vi.spyOn(live.instance, 'onDidDispose')
    editorSelectionCache.set('live.ts', [selection])
    scrollTopCache.set('live.ts', 96)
    scrollTopCache.set('closed.ts', 320)
    pauseFrames()
    restoreMonacoViewState(closed.instance, 'closed.ts')
    restoreMonacoViewState(live.instance, 'live.ts')
    const subscription = subscribe.mock.results[0]
    if (subscription?.type !== 'return') {
      throw new Error('Restore must subscribe to the installed editor disposal event')
    }
    const unsubscribe = vi.spyOn(subscription.value, 'dispose')
    closed.dispose()
    expect(frames.size).toBe(1)
    flushFrames()

    expect(live.instance.getSelection()).toEqual(selection)
    expect(scroll).toHaveBeenCalledWith(96)
    expect(focus).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(live.model.getValue()).toBe('one\ntwo\nthree')
    expect(live.model.canUndo()).toBe(false)
  })

  it('focuses immediately without scheduling a frame when there is no cached state', () => {
    const target = createEditor()
    const focus = vi.spyOn(target.instance, 'focus')
    pauseFrames()
    restoreMonacoViewState(target.instance, 'new.ts')

    expect(focus).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
  })
})
