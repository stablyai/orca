import { describe, expect, it } from 'vitest'
import { MEDIA_FILE_MIME_TYPES, isMediaPreviewMimeType } from './media-file-extensions'

describe('media-file-extensions', () => {
  it('maps every media extension to an audio/* or video/* mime type', () => {
    for (const [extension, mimeType] of Object.entries(MEDIA_FILE_MIME_TYPES)) {
      expect(extension.startsWith('.')).toBe(true)
      expect(isMediaPreviewMimeType(mimeType)).toBe(true)
    }
  })

  it('covers the webm container', () => {
    expect(MEDIA_FILE_MIME_TYPES['.webm']).toBe('video/webm')
  })

  it('covers the Ogg audio container', () => {
    expect(MEDIA_FILE_MIME_TYPES['.ogg']).toBe('audio/ogg')
  })

  it('rejects image, pdf, and missing mime types', () => {
    expect(isMediaPreviewMimeType('image/png')).toBe(false)
    expect(isMediaPreviewMimeType('application/pdf')).toBe(false)
    expect(isMediaPreviewMimeType(undefined)).toBe(false)
    expect(isMediaPreviewMimeType('')).toBe(false)
  })
})
