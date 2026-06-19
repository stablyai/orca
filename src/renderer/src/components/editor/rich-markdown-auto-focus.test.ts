import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

function createEditor(focus = vi.fn()): Editor {
  return {
    isDestroyed: false,
    commands: { focus }
  } as unknown as Editor
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
    let pendingFrame: FrameRequestCallback = () => {
      throw new Error('expected focus frame to be scheduled')
    }
    const focus = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrame = callback
      return 7
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('document', { activeElement: null, body: {} })

    autoFocusRichEditor(createEditor(focus), null)
    pendingFrame(0)

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })
})
