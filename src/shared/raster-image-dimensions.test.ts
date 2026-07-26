import { describe, expect, it } from 'vitest'
import { readRasterImageDimensions } from './raster-image-dimensions'

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

function bmpHeader(width: number, height: number): Buffer {
  const bmp = Buffer.alloc(26)
  bmp.write('BM', 0, 'ascii')
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(width, 18)
  bmp.writeInt32LE(height, 22)
  return bmp
}

function icoWithPayload(payload: Buffer, width = 1, height = 1): Buffer {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = width === 256 ? 0 : width
  header[7] = height === 256 ? 0 : height
  header.writeUInt32LE(payload.byteLength, 14)
  header.writeUInt32LE(header.byteLength, 18)
  return Buffer.concat([header, payload])
}

describe('readRasterImageDimensions', () => {
  it('reads BMP dimensions including top-down images', () => {
    expect(readRasterImageDimensions(bmpHeader(640, -480))).toEqual({
      width: 640,
      height: 480
    })
  })

  it('uses embedded ICO image dimensions instead of forgeable directory values', () => {
    expect(readRasterImageDimensions(icoWithPayload(pngHeader(40_000, 2)))).toEqual({
      width: 40_000,
      height: 2
    })
  })

  it('reads a Uint8Array view without depending on its backing-buffer offset', () => {
    const wrapped = Buffer.concat([Buffer.from('prefix'), pngHeader(320, 240), Buffer.from('tail')])
    const view = wrapped.subarray(6, 30)

    expect(readRasterImageDimensions(view)).toEqual({ width: 320, height: 240 })
  })

  it('rejects truncated ICO payloads and zero raster dimensions', () => {
    const truncated = icoWithPayload(pngHeader(16, 16)).subarray(0, 30)

    expect(readRasterImageDimensions(truncated)).toBeNull()
    expect(readRasterImageDimensions(bmpHeader(0, 16))).toBeNull()
  })
})
