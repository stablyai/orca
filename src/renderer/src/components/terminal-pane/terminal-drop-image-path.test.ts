import { describe, expect, it } from 'vitest'
import { isImageDropPath } from './terminal-drop-image-path'

describe('isImageDropPath', () => {
  it('detects common image extensions case-insensitively', () => {
    for (const path of [
      '/repo/shot.png',
      '/repo/shot.PNG',
      '/repo/a.jpg',
      '/repo/a.jpeg',
      '/repo/a.gif',
      '/repo/icon.svg',
      '/repo/a.webp',
      '/repo/a.bmp',
      '/repo/a.ico',
      'C:\\Users\\me\\Pictures\\diagram.PnG'
    ]) {
      expect(isImageDropPath(path)).toBe(true)
    }
  })

  it('rejects non-image and extension-less paths', () => {
    for (const path of [
      '/repo/index.ts',
      '/repo/notes.md',
      '/repo/archive.tar.gz',
      '/repo/Makefile',
      '/repo/.gitignore'
    ]) {
      expect(isImageDropPath(path)).toBe(false)
    }
  })

  it('does not classify directory components with dots as images', () => {
    expect(isImageDropPath('/home/jane.png/photo')).toBe(false)
    expect(isImageDropPath('/home/jane.doe/screenshot')).toBe(false)
  })
})
