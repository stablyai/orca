import { describe, expect, it } from 'vitest'
import { withSniffedImageExtension } from './image-file-signature'

describe('withSniffedImageExtension', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  it('adds the image suffix to an extensionless image and leaves other names alone', () => {
    expect(withSniffedImageExtension('Screenshot', png)).toBe('Screenshot.png')
    expect(withSniffedImageExtension('shot.jpeg', png)).toBe('shot.jpeg')
    expect(withSniffedImageExtension('notes', Uint8Array.from([0x23, 0x20]))).toBe('notes')
  })
})
