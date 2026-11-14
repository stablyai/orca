import { describe, expect, it } from 'vitest'
import { exceedsRasterImagePreviewLimits } from './raster-image-base64-preview'

function pngBytes(totalBytes: number, width: number, height: number): Buffer {
  const bytes = Buffer.alloc(Math.max(totalBytes, 24))
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  for (let index = 24; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 7) & 0xff
  }
  return bytes
}

describe('exceedsRasterImagePreviewLimits', () => {
  it('keeps rendering an over-limit header whose payload is not valid base64', () => {
    const content = `${pngBytes(70_000, 32_769, 1).toString('base64')}!!!`
    expect(exceedsRasterImagePreviewLimits(content, 'image/png')).toBe(false)
  })
})
