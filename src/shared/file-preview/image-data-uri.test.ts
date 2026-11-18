import { describe, expect, it } from 'vitest'
import { buildImageDataUri } from './image-data-uri'

function pngBase64(width = 1, height = 1): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('buildImageDataUri', () => {
  it('rejects oversized known rasters before native decode', () => {
    expect(buildImageDataUri('image/png', pngBase64(32_769, 1))).toBeNull()
    expect(buildImageDataUri('image/png', pngBase64(8192, 8192))).toBeNull()
  })

  it('still renders bytes whose header we cannot measure', () => {
    // Unreadable headers do not prove oversize; decoder-supported formats beyond this parser must remain visible.
    expect(buildImageDataUri('image/png', 'bmV3')).toBe('data:image/png;base64,bmV3')
  })
})
