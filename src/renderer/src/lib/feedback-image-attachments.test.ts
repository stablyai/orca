// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES,
  readFeedbackImageFiles
} from './feedback-image-attachments'
import type * as FeedbackImageShrinkModule from './feedback-image-shrink'

const { shrinkFeedbackImage } = vi.hoisted(() => ({ shrinkFeedbackImage: vi.fn() }))

// Why: happy-dom has no image decoder; full-resolution PNG encoding has a separate test.
vi.mock('./feedback-image-shrink', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackImageShrinkModule>()),
  shrinkFeedbackImage
}))

beforeEach(() => {
  shrinkFeedbackImage.mockReset()
  shrinkFeedbackImage.mockResolvedValue(null)
  let next = 0
  URL.createObjectURL = vi.fn(() => `blob:feedback-${(next += 1)}`)
  URL.revokeObjectURL = vi.fn()
})

function pngHeader(width = 1, height = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(24))
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([73, 72, 68, 82], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function pngFile(name: string, size = 24, dimensions = { width: 1, height: 1 }): File {
  const file = new File([pngHeader(dimensions.width, dimensions.height)], name, {
    type: 'image/png'
  })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function pngChunk(
  type: string,
  payload: Uint8Array,
  declaredLength = payload.byteLength
): Uint8Array<ArrayBuffer> {
  // CRC left zero: the reader does not verify it.
  const chunk = new Uint8Array(new ArrayBuffer(12 + payload.byteLength))
  new DataView(chunk.buffer).setUint32(0, declaredLength)
  chunk.set(new TextEncoder().encode(type), 4)
  chunk.set(payload, 8)
  return chunk
}

function oversizedPng(
  name: string,
  chunks: [type: string, payload: Uint8Array, declaredLength?: number][]
): File {
  const ihdr = pngChunk('IHDR', new Uint8Array(13))
  new DataView(ihdr.buffer).setUint32(8, 1)
  new DataView(ihdr.buffer).setUint32(12, 1)
  const file = new File(
    [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      ihdr,
      ...chunks.map(([type, payload, declaredLength]) => pngChunk(type, payload, declaredLength))
    ],
    name,
    { type: 'image/png' }
  )
  Object.defineProperty(file, 'size', { value: MAX_FEEDBACK_IMAGE_BYTES + 1 })
  return file
}

function encoded(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type })
}

describe('readFeedbackImageFiles', () => {
  it('refuses an oversized animated PNG rather than flattening it', async () => {
    // Why: a large metadata chunk can push acTL well past the first 64 KB.
    const apng = oversizedPng('anim.png', [
      ['iTXt', new Uint8Array(100 * 1024)],
      ['acTL', new Uint8Array(8)],
      ['IDAT', new Uint8Array(16)]
    ])

    const { images, errors } = await readFeedbackImageFiles([apng], 0)

    expect(shrinkFeedbackImage).not.toHaveBeenCalled()
    expect(images).toEqual([])
    expect(errors).toEqual(['anim.png is larger than 4.0 MB.'])
  })

  it('still shrinks a still PNG whose metadata or pixels happen to spell acTL', async () => {
    const acTL = new TextEncoder().encode('acTL')
    const still = oversizedPng('still.png', [
      ['tEXt', acTL],
      ['IDAT', acTL]
    ])
    shrinkFeedbackImage.mockResolvedValue(encoded(1_800_000, 'image/png'))

    const { images, errors } = await readFeedbackImageFiles([still], 0)

    expect(errors).toEqual([])
    expect(shrinkFeedbackImage).toHaveBeenCalledWith(still, MAX_FEEDBACK_IMAGE_SHRINK_TARGET_BYTES)
    expect(images.map((image) => image.name)).toEqual(['still.png'])
  })

  // Why: a corrupt length past 2^31 must end the walk, not throw or wrap back into the file.
  it('treats a PNG whose chunk lengths run past its end as still', async () => {
    const corrupt = oversizedPng('corrupt-length.png', [
      ['tEXt', new Uint8Array(0)],
      ['tEXt', new Uint8Array(4), 0x8000_0000],
      ['acTL', new Uint8Array(8)]
    ])
    shrinkFeedbackImage.mockResolvedValue(encoded(1_800_000, 'image/png'))

    const { images, errors } = await readFeedbackImageFiles([corrupt], 0)

    expect(errors).toEqual([])
    expect(images.map((image) => image.name)).toEqual(['corrupt-length.png'])
  })

  it('counts already attached bytes and still fits a later smaller image', async () => {
    const { images, errors } = await readFeedbackImageFiles(
      [pngFile('big.png', 2048), pngFile('small.png', 1024)],
      1,
      MAX_FEEDBACK_IMAGE_TOTAL_BYTES - 1024
    )

    expect(images.map((image) => image.name)).toEqual(['small.png'])
    expect(errors).toEqual(['big.png would bring the attachments over 4.0 MB in total.'])
  })

  it('rejects a raster that would exceed the decoded preview budget', async () => {
    const file = pngFile('huge-dimensions.png', 24, { width: 8192, height: 8192 })

    const { images, errors } = await readFeedbackImageFiles([file], 0)

    expect(images).toEqual([])
    expect(errors).toEqual([
      'huge-dimensions.png has dimensions that are too large to preview safely.'
    ])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('does not count a rejected preview against the attachment limit', async () => {
    const files = [
      new File(['not an image'], 'broken.png', { type: 'image/png' }),
      ...Array.from({ length: MAX_FEEDBACK_IMAGE_COUNT }, (_, index) =>
        pngFile(`valid-${index}.png`)
      )
    ]

    const { images, errors } = await readFeedbackImageFiles(files, 0)

    expect(images).toHaveLength(MAX_FEEDBACK_IMAGE_COUNT)
    expect(errors).toEqual(['broken.png is not a valid supported image.'])
  })

  it('revokes previews already created when a later read in the batch fails', async () => {
    const good = pngFile('good.png')
    const broken = pngFile('broken.png')
    broken.arrayBuffer = () => Promise.reject(new Error('file went away'))

    await expect(readFeedbackImageFiles([good, broken], 0)).rejects.toThrow('file went away')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:feedback-1')
  })
})
