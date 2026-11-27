import { expect, it } from 'vitest'
import { buildImageDataUri, validateRasterImageDataUri } from './image-data-uri'

it('accepts case-insensitive image MIME types without bypassing raster limits', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
  const uri = `data:IMAGE/PNG;base64,${png}`
  expect(buildImageDataUri('IMAGE/PNG', png)).toBe(uri)
  expect(validateRasterImageDataUri(uri)).toBe(uri)

  const oversized = Buffer.from(png, 'base64')
  oversized.writeUInt32BE(32_769, 16)
  expect(buildImageDataUri('Image/PNG', oversized.toString('base64'))).toBeNull()
  expect(buildImageDataUri('text/plain', png)).toBeNull()
})
