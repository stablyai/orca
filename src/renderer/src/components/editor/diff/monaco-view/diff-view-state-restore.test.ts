import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { restoreDiffViewStateWhileLayoutSettles } from './diff-view-state-restore'

type Listener<T> = (event: T) => void

function emitter<T>(): {
  on: (listener: Listener<T>) => { dispose: () => void }
  fire: Listener<T>
} {
  const listeners = new Set<Listener<T>>()
  return {
    on: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (event) => listeners.forEach((listener) => listener(event))
  }
}

// Saved view: first visible line 100 at its top. Each line is 20 px plus whatever zone height sits above it.
function createDiffEditorDouble() {
  const container = new EventTarget()
  const contentSize = emitter<Partial<editor.IContentSizeChangedEvent>>()
  const cursor = emitter<Partial<editor.ICursorPositionChangedEvent>>()
  const disposed = emitter<void>()
  let zoneHeightAbove = 40_000
  let scrollTop = 0
  const topOfLine = (lineNumber: number): number => lineNumber * 20 + zoneHeightAbove
  const modifiedEditor = {
    getTopForPosition: topOfLine,
    getScrollTop: () => scrollTop,
    getScrollHeight: () => 1_000_000,
    getLayoutInfo: () => ({ height: 800 }),
    onDidContentSizeChange: contentSize.on,
    onDidChangeModel: () => ({ dispose: () => {} }),
    onDidChangeCursorPosition: cursor.on
  }
  const originalEditor = {
    onDidContentSizeChange: () => ({ dispose: () => {} }),
    onDidChangeModel: () => ({ dispose: () => {} })
  }
  const restoreViewState = (): void => {
    scrollTop = topOfLine(100)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements every diff editor method the restore helper calls.
  const diffEditor = {
    getOriginalEditor: () => originalEditor,
    getModifiedEditor: () => modifiedEditor,
    getModel: () => ({}),
    getContainerDomNode: () => container,
    onDidDispose: disposed.on,
    restoreViewState
  } as unknown as editor.IStandaloneDiffEditor
  // Monaco shrinks stale zones a task after mount and its scroll sync clamps the restored position to the top.
  const scrollTo = (top: number): void => {
    scrollTop = top
  }
  const changeHeight = async (): Promise<void> => {
    contentSize.fire({ contentHeightChanged: true })
    await Promise.resolve()
  }
  const shrinkZonesAndClampScroll = async (): Promise<void> => {
    zoneHeightAbove = 1_000
    scrollTop = 0
    await changeHeight()
  }
  return {
    diffEditor,
    container,
    fireCursor: cursor.fire,
    fireDispose: () => disposed.fire(),
    getScrollTop: () => scrollTop,
    scrollTo,
    changeHeight,
    shrinkZonesAndClampScroll
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only modified.viewState's first position fields.
const savedViewState = {
  original: null,
  modified: {
    viewState: { firstPosition: { lineNumber: 100, column: 1 }, firstPositionDeltaTop: 0 }
  }
} as unknown as editor.IDiffEditorViewState

describe('restoreDiffViewStateWhileLayoutSettles', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {}
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const runFrames = (): void => frames.splice(0).forEach((frame) => frame(0))

  it('restores after layout drift only within the window started by the first restore', async () => {
    const double = createDiffEditorDouble()
    restoreDiffViewStateWhileLayoutSettles(double.diffEditor, savedViewState)
    vi.advanceTimersByTime(1000)
    runFrames()
    expect(double.getScrollTop()).toBe(42_000)

    vi.advanceTimersByTime(999)
    await double.shrinkZonesAndClampScroll()
    expect(double.getScrollTop()).toBe(3_000)

    vi.advanceTimersByTime(1)
    await double.shrinkZonesAndClampScroll()
    expect(double.getScrollTop()).toBe(0)
  })

  it.each([
    [
      'wheel input in the diff',
      (double: ReturnType<typeof createDiffEditorDouble>) => {
        double.container.dispatchEvent(new Event('wheel'))
      }
    ],
    [
      'header next-change navigation',
      (double: ReturnType<typeof createDiffEditorDouble>) => {
        double.fireCursor({ source: 'api' })
      }
    ]
  ])('leaves the view alone after %s', async (_label, endWindow) => {
    const double = createDiffEditorDouble()
    restoreDiffViewStateWhileLayoutSettles(double.diffEditor, savedViewState)
    runFrames()
    endWindow(double)

    await double.shrinkZonesAndClampScroll()

    expect(double.getScrollTop()).toBe(0)
  })

  it('keeps the note position when note navigation ends the window after the restore', async () => {
    const double = createDiffEditorDouble()
    const restoreHandle = restoreDiffViewStateWhileLayoutSettles(double.diffEditor, savedViewState)
    runFrames()
    restoreHandle.dispose()
    double.scrollTo(5_000)

    await double.changeHeight()

    expect(double.getScrollTop()).toBe(5_000)
  })

  it('still applies the first restore when disposed early for note navigation', async () => {
    const double = createDiffEditorDouble()
    restoreDiffViewStateWhileLayoutSettles(double.diffEditor, savedViewState).dispose()
    runFrames()
    expect(double.getScrollTop()).toBe(42_000)

    await double.shrinkZonesAndClampScroll()

    expect(double.getScrollTop()).toBe(0)
  })

  it('skips the first restore when the editor is disposed before the frame', () => {
    const double = createDiffEditorDouble()
    restoreDiffViewStateWhileLayoutSettles(double.diffEditor, savedViewState)
    double.fireDispose()
    runFrames()

    expect(double.getScrollTop()).toBe(0)
  })
})
