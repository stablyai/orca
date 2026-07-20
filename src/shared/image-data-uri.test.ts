import { describe, expect, it } from 'vitest'
import { buildImageDataUri } from './image-data-uri'

describe('buildImageDataUri', () => {
  it('builds a data URI from base64 image bytes', () => {
    expect(buildImageDataUri('image/png', 'bmV3')).toBe('data:image/png;base64,bmV3')
  })

  it('strips whitespace from line-wrapped base64 payloads', () => {
    expect(buildImageDataUri('image/png', 'bm\nV3\t bmV3\r\n')).toBe(
      'data:image/png;base64,bmV3bmV3'
    )
  })

  it('returns null for an empty payload', () => {
    expect(buildImageDataUri('image/png', '   \n')).toBeNull()
  })

  it('returns null for a missing mime type', () => {
    expect(buildImageDataUri(undefined, 'bmV3')).toBeNull()
  })

  it('returns null for application/pdf (not an <img> source)', () => {
    expect(buildImageDataUri('application/pdf', 'JVBER')).toBeNull()
  })

  it('returns null for a non-image mime such as application/octet-stream', () => {
    expect(buildImageDataUri('application/octet-stream', 'AAAA')).toBeNull()
  })
})
