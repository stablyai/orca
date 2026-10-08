// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureMarkupBaseImage } from './markup-base-image'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('captureMarkupBaseImage surface source', () => {
  it('flattens a surface data URL onto opaque white at its declared size', async () => {
    const drawImage = vi.fn()
    const fillRect = vi.fn()
    const context: Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect' | 'fillStyle'> = {
      drawImage,
      fillRect,
      fillStyle: ''
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Capture uses only these three checked 2d context members.
      context as CanvasRenderingContext2D
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,flattened'
    )
    class ImageStub {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', ImageStub)

    await expect(
      captureMarkupBaseImage({
        kind: 'surface',
        capture: async () => ({ dataUrl: 'data:image/png;base64,raw', width: 20, height: 10 })
      })
    ).resolves.toEqual({ dataUrl: 'data:image/png;base64,flattened', width: 20, height: 10 })
    expect(fillRect).toHaveBeenCalledWith(0, 0, 20, 10)
    expect(drawImage).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    { dataUrl: 'data:image/png;base64,x', width: 0, height: 1 },
    { dataUrl: 'data:image/png;base64,x', width: Number.NaN, height: 1 },
    { dataUrl: 'data:image/png;base64,x', width: 1, height: Number.POSITIVE_INFINITY }
  ])('rejects unavailable or invalid surface capture %p', async (value) => {
    await expect(
      captureMarkupBaseImage({ kind: 'surface', capture: async () => value })
    ).rejects.toThrow('surface capture unavailable')
  })

  it('propagates a surface capture rejection', async () => {
    await expect(
      captureMarkupBaseImage({
        kind: 'surface',
        capture: async () => {
          throw new Error('disposed')
        }
      })
    ).rejects.toThrow('disposed')
  })
})
