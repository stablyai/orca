import { describe, expect, it } from 'vitest'
import { readPluginImageHeader } from './plugin-image-format'

function chunk(type: string, data: number[] = []): number[] {
  const length = data.length
  return [
    length >>> 24,
    (length >>> 16) & 255,
    (length >>> 8) & 255,
    length & 255,
    ...Buffer.from(type),
    ...data,
    0,
    0,
    0,
    0
  ]
}
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function pngBytes(width: number, height: number, animated = false): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...(animated ? chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]) : []),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND')
  ])
}

function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    0,
    0,
    0
  ])
}

function webpVp8x(width: number, height: number, flags: number): Uint8Array {
  const w = width - 1
  const h = height - 1
  return Uint8Array.from([
    ...Buffer.from('RIFF'),
    0,
    0,
    0,
    0,
    ...Buffer.from('WEBP'),
    ...Buffer.from('VP8X'),
    10,
    0,
    0,
    0,
    flags,
    0,
    0,
    0,
    w & 255,
    (w >> 8) & 255,
    (w >> 16) & 255,
    h & 255,
    (h >> 8) & 255,
    (h >> 16) & 255
  ])
}

describe('readPluginImageHeader', () => {
  it('reads PNG, JPEG and WebP sizes from headers', () => {
    expect(readPluginImageHeader(pngBytes(512, 512))).toEqual({
      format: 'png',
      width: 512,
      height: 512
    })
    expect(readPluginImageHeader(jpegBytes(1600, 1000))).toEqual({
      format: 'jpeg',
      width: 1600,
      height: 1000
    })
    expect(readPluginImageHeader(webpVp8x(1280, 800, 0))).toEqual({
      format: 'webp',
      width: 1280,
      height: 800
    })
  })
})
