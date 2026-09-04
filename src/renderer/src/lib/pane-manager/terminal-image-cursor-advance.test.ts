import { describe, expect, it, vi } from 'vitest'
import { attachImageCursorAdvance } from './terminal-image-cursor-advance'

function createHarness() {
  const buffer = { x: 42 }
  const lineFeed = vi.fn()
  const terminal = {
    _core: {
      buffer,
      _inputHandler: { lineFeed }
    }
  } as never

  let imageAddedCb: (() => void) | null = null
  const disposeSpy = vi.fn()
  const imageAddon = {
    onImageAdded: vi.fn((cb: () => void) => {
      imageAddedCb = cb
      return { dispose: disposeSpy }
    })
  } as never

  return {
    terminal,
    imageAddon,
    buffer,
    lineFeed,
    fireImageAdded: () => imageAddedCb?.(),
    disposeSpy
  }
}

describe('attachImageCursorAdvance', () => {
  it('advances cursor to column 0 of the next row after an image', () => {
    const { terminal, imageAddon, buffer, lineFeed, fireImageAdded } = createHarness()

    attachImageCursorAdvance(terminal, imageAddon)
    buffer.x = 80
    fireImageAdded()

    expect(lineFeed).toHaveBeenCalledOnce()
    expect(buffer.x).toBe(0)
  })

  it('returns a disposable that unsubscribes the listener', () => {
    const { terminal, imageAddon, disposeSpy } = createHarness()

    const disposable = attachImageCursorAdvance(terminal, imageAddon)
    disposable.dispose()

    expect(disposeSpy).toHaveBeenCalledOnce()
  })
})
