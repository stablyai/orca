import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  feedbackImageShrinkSteps,
  shrinkFeedbackImage,
  shrinkFeedbackImageWithin,
  type FeedbackImageShrinkStep
} from './feedback-image-shrink'

function encoderBySize(sizeFor: (step: FeedbackImageShrinkStep) => number | null): {
  encode: (step: FeedbackImageShrinkStep) => Promise<Blob | null>
  tried: FeedbackImageShrinkStep[]
} {
  const tried: FeedbackImageShrinkStep[] = []
  return {
    tried,
    encode: async (step) => {
      tried.push(step)
      const size = sizeFor(step)
      return size === null ? null : new Blob([new Uint8Array(size)], { type: step.contentType })
    }
  }
}

const pngSteps = feedbackImageShrinkSteps('image/png')

describe('feedbackImageShrinkSteps', () => {
  it('tries every PNG size before the first lossy one for a PNG source', () => {
    expect(pngSteps.map((step) => step.contentType)).toEqual([
      'image/png',
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg'
    ])
  })

  // Why: a PNG of decoded JPEG noise is larger than the source it must undercut,
  // so those two full-size encodes could only ever waste time and memory.
  it('skips the PNG sizes for an already-lossy JPEG source', () => {
    expect(
      feedbackImageShrinkSteps('image/jpeg').every((step) => step.contentType === 'image/jpeg')
    ).toBe(true)
  })

  it('keeps every step a downscale or a same-size re-encode', () => {
    expect(pngSteps.every((step) => step.scale > 0 && step.scale <= 1)).toBe(true)
  })
})

describe('shrinkFeedbackImageWithin', () => {
  it('stops at the first encoding that fits', async () => {
    const { encode, tried } = encoderBySize((step) =>
      step.contentType === 'image/png' && step.scale === 0.5 ? 900 : 5000
    )

    const blob = await shrinkFeedbackImageWithin(pngSteps, encode, 1000)

    expect(blob?.size).toBe(900)
    expect(blob?.type).toBe('image/png')
    expect(tried.at(-1)).toEqual({ scale: 0.5, contentType: 'image/png' })
  })

  // Why: screenshots are mostly text, so every PNG size is tried before any JPEG.
  it('falls back to JPEG only after every PNG size is too big', async () => {
    const { encode, tried } = encoderBySize((step) =>
      step.contentType === 'image/jpeg' ? 800 : 5000
    )

    const blob = await shrinkFeedbackImageWithin(pngSteps, encode, 1000)

    expect(blob?.type).toBe('image/jpeg')
    expect(tried.map((step) => step.contentType)).toEqual(['image/png', 'image/png', 'image/jpeg'])
  })

  it('returns null when nothing fits or the browser cannot encode', async () => {
    expect(
      await shrinkFeedbackImageWithin(pngSteps, encoderBySize(() => 5000).encode, 1000)
    ).toBeNull()
    expect(
      await shrinkFeedbackImageWithin(pngSteps, encoderBySize(() => null).encode, 1000)
    ).toBeNull()
  })
})

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

  it('decodes once, downscales each step, and releases the bitmap and every canvas', async () => {
    const { canvases, bitmap } = stubCanvas((canvas) => (canvas.width > 1000 ? 5000 : 900))

    const blob = await shrinkFeedbackImage(new Blob(['x'], { type: 'image/png' }), 1000)

    expect(blob?.type).toBe('image/png')
    expect(blob?.size).toBe(900)
    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(canvases.map((canvas) => canvas.calls[0])).toEqual(['draw 1500x750', 'draw 1000x500'])
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  // Why: JPEG has no alpha, so a transparent screenshot region would otherwise encode black.
  it('paints a white backdrop under a JPEG step and encodes at the set quality', async () => {
    const { canvases } = stubCanvas(() => 900)

    const blob = await shrinkFeedbackImage(new Blob(['x'], { type: 'image/jpeg' }), 1000)

    expect(blob?.type).toBe('image/jpeg')
    expect(canvases[0].calls).toEqual([
      'fillStyle #fff',
      'fillRect',
      'draw 2000x1000',
      'toBlob image/jpeg 0.85'
    ])
  })

  it('releases the bitmap when nothing fits', async () => {
    const { canvases, bitmap } = stubCanvas(() => 5000)

    await expect(
      shrinkFeedbackImage(new Blob(['x'], { type: 'image/png' }), 1000)
    ).resolves.toBeNull()
    expect(canvases).toHaveLength(feedbackImageShrinkSteps('image/png').length)
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
