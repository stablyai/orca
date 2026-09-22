import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { restoreMonacoViewState } from './monaco-view-state-persistence'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function createEditor() {
  const disposalListeners = new Set<() => void>()
  const instance = {
    focus: vi.fn(),
    setSelections: vi.fn(),
    setScrollTop: vi.fn(),
    onDidDispose(listener) {
      disposalListeners.add(listener)
      return { dispose: () => disposalListeners.delete(listener) }
    }
  } satisfies Pick<
    editor.IStandaloneCodeEditor,
    'focus' | 'setSelections' | 'setScrollTop' | 'onDidDispose'
  >
  return {
    instance,
    disposalListeners,
    dispose() {
      for (const listener of disposalListeners) {
        listener()
      }
      disposalListeners.clear()
    }
  }
}

beforeEach(() => {
  frames.clear()
  nextFrame = 0
  editorSelectionCache.clear()
  scrollTopCache.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = ++nextFrame
    frames.set(frame, callback)
    return frame
  })
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frame: number) => frames.delete(frame))
  )
})

afterEach(() => {
  frames.clear()
  editorSelectionCache.clear()
  scrollTopCache.clear()
  vi.unstubAllGlobals()
})

describe('Monaco view state restoration ownership', () => {
  it('releases queued restorations when editors close before animation frames run', () => {
    scrollTopCache.set('file.ts', 320)
    for (let index = 0; index < 40; index += 1) {
      const target = createEditor()
      restoreMonacoViewState(target.instance, 'file.ts')
      target.dispose()
    }

    expect(frames.size).toBe(0)
  })

  it('removes its disposal listener after restoring an active editor', () => {
    scrollTopCache.set('file.ts', 320)
    const target = createEditor()
    restoreMonacoViewState(target.instance, 'file.ts')
    expect(target.disposalListeners.size).toBe(1)

    for (const [frame, callback] of frames) {
      frames.delete(frame)
      callback(0)
    }

    expect(target.instance.setScrollTop).toHaveBeenCalledWith(320)
    expect(target.instance.focus).toHaveBeenCalledOnce()
    expect(target.disposalListeners.size).toBe(0)
    target.dispose()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
  })

  it('focuses immediately without retaining resources when no state is cached', () => {
    const target = createEditor()
    restoreMonacoViewState(target.instance, 'file.ts')

    expect(target.instance.focus).toHaveBeenCalledOnce()
    expect(frames.size).toBe(0)
    expect(target.disposalListeners.size).toBe(0)
  })
})
