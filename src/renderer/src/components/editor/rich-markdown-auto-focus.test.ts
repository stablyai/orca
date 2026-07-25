import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

function createEditor(focus = vi.fn()): Editor {
  return {
    isDestroyed: false,
    commands: { focus }
  } as unknown as Editor
}

function setupScheduledFocus(
  activeElement: object | null,
  force = false
): {
  focus: ReturnType<typeof vi.fn>
  runFrame: () => void
} {
  let pendingFrame: FrameRequestCallback = () => {
    throw new Error('expected focus frame to be scheduled')
  }
  const focus = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrame = callback
    return 7
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', { activeElement, body: {} })
  autoFocusRichEditor(createEditor(focus), null, force)

  return {
    focus,
    runFrame: () => pendingFrame(0)
  }
}

describe('autoFocusRichEditor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns cleanup that cancels the pending focus frame', () => {
    const cancelAnimationFrameMock = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    const cleanup = autoFocusRichEditor(createEditor(), null)
    cleanup()
    cleanup()

    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(42)
  })

  it('focuses the editor when the frame fires with neutral focus', () => {
    const { focus, runFrame } = setupScheduledFocus(null)
    runFrame()

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('honors an explicit focus handoff', () => {
    const { focus, runFrame } = setupScheduledFocus({}, true)
    runFrame()

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('does not steal focus from other controls outside the editor', () => {
    const { focus, runFrame } = setupScheduledFocus({})
    runFrame()

    expect(focus).not.toHaveBeenCalled()
  })
})
