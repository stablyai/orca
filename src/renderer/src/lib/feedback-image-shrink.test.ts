import { afterEach, describe, expect, it, vi } from 'vitest'
import { shrinkFeedbackImage } from './feedback-image-shrink'

describe('shrinkFeedbackImage', () => {
  type FakeCanvas = { width: number; height: number; calls: string[] }

  // Why: the node test env has no decoder or canvas, so stub both and record
  // what the real encode path does with them.
  function stubCanvas(sizeFor: (canvas: FakeCanvas, type: string) => number): {
    canvases: FakeCanvas[]
    bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }
  } {
    const canvases: FakeCanvas[] = []
    const bitmap = { width: 2000, height: 1000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.stubGlobal('document', {
      createElement: () => {
        const calls: string[] = []
        const canvas = {
          width: 0,
          height: 0,
          calls,
          getContext: () => ({
            set fillStyle(value: string) {
              canvas.calls.push(`fillStyle ${value}`)
            },
            fillRect: () => canvas.calls.push('fillRect'),
            drawImage: () => canvas.calls.push(`draw ${canvas.width}x${canvas.height}`)
          }),
          toBlob: (callback: (blob: Blob | null) => void, type: string, quality: number) => {
            canvas.calls.push(`toBlob ${type} ${quality}`)
            callback(new Blob([new Uint8Array(sizeFor(canvas, type))], { type }))
          }
        }
        canvases.push(canvas)
        return canvas
      }
    })
    return { canvases, bitmap }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['image/png', 'image/jpeg'])(
    'preserves full resolution and avoids JPEG re-encoding for %s',
    async (sourceType) => {
      const { canvases, bitmap } = stubCanvas(() => 900)

      const blob = await shrinkFeedbackImage(new Blob(['x'], { type: sourceType }), 1000)

      expect(blob?.type).toBe('image/png')
      expect(blob?.size).toBe(900)
      expect(createImageBitmap).toHaveBeenCalledTimes(1)
      expect(canvases).toHaveLength(1)
      expect(canvases[0].calls).toEqual(['draw 2000x1000', 'toBlob image/png undefined'])
      expect(canvases[0].width).toBe(0)
      expect(canvases[0].height).toBe(0)
      expect(bitmap.close).toHaveBeenCalledTimes(1)
    }
  )

  it('releases the bitmap when nothing fits', async () => {
    const { canvases, bitmap } = stubCanvas(() => 5000)

    await expect(
      shrinkFeedbackImage(new Blob(['x'], { type: 'image/png' }), 1000)
    ).resolves.toBeNull()
    expect(canvases).toHaveLength(1)
    expect(canvases[0].width).toBe(0)
    expect(canvases[0].height).toBe(0)
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  // Why: the caller reports a decode failure as an invalid image, not as too large.
  it('rejects when the browser cannot decode the image', async () => {
    stubCanvas(() => 0)
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')))

    await expect(shrinkFeedbackImage(new Blob(['x'], { type: 'image/png' }), 1000)).rejects.toThrow(
      'decode failed'
    )
  })
})
