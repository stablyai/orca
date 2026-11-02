// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { useMonacoRevealScheduler } from './use-monaco-reveal-scheduler'
import { performReveal } from './monaco-reveal'

vi.mock('./monaco-reveal', () => ({ MAX_REVEAL_CONTENT_WAIT_FRAMES: 120, performReveal: vi.fn() }))

const frames: FrameRequestCallback[] = []
const model = { getLineCount: () => 400 }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scheduler reads only getModel/getLineCount; performReveal is mocked.
const instance = { getModel: () => model } as unknown as editor.IStandaloneCodeEditor

function flushFrames(): void {
  while (frames.length) {
    frames.shift()?.(0)
  }
}

describe('Monaco reveal application guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('does not focus or move the editor when its target becomes inactive before application', () => {
    const { result, unmount } = renderHook(() => useMonacoRevealScheduler())
    let current = true
    const applied = vi.fn()
    act(() => result.current.queueReveal(instance, 300, 7, 0, applied, () => current))
    frames.shift()?.(0)
    current = false
    flushFrames()
    expect(performReveal).not.toHaveBeenCalled()
    expect(applied).not.toHaveBeenCalled()
    unmount()
  })

  it('applies and acknowledges a still-current target, preserving legacy callers', () => {
    const { result, unmount } = renderHook(() => useMonacoRevealScheduler())
    const applied = vi.fn()
    act(() => result.current.queueReveal(instance, 300, 7, 0, applied))
    flushFrames()
    expect(performReveal).toHaveBeenCalledWith(
      instance,
      300,
      7,
      0,
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    )
    expect(applied).toHaveBeenCalledOnce()
    unmount()
  })

  it('checks the guard again after waiting for asynchronous file content', () => {
    const { result, unmount } = renderHook(() => useMonacoRevealScheduler())
    let current = true
    vi.spyOn(model, 'getLineCount').mockReturnValueOnce(1).mockReturnValue(400)
    act(() => result.current.queueReveal(instance, 300, 7, 0, undefined, () => current))
    frames.shift()?.(0)
    frames.shift()?.(0)
    current = false
    flushFrames()
    expect(performReveal).not.toHaveBeenCalled()
    unmount()
  })
})
