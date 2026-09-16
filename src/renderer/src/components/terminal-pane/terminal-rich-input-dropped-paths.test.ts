import { describe, expect, it, vi } from 'vitest'
import { dispatchTerminalRichInputDroppedPaths } from './terminal-rich-input-dropped-paths'

describe('dispatchTerminalRichInputDroppedPaths', () => {
  it('preserves mixed file and image order', () => {
    const inserted: string[] = []

    dispatchTerminalRichInputDroppedPaths({
      paths: ['a.txt', 'b.png', 'c.ts', 'd.jpg'],
      canAttachImages: true,
      insertImagePath: (path) => inserted.push(`image:${path}`),
      insertFilePath: (path) => inserted.push(`file:${path}`)
    })

    expect(inserted).toEqual(['file:a.txt', 'image:b.png', 'file:c.ts', 'image:d.jpg'])
  })

  it('routes images through file insertion when attachments are disabled', () => {
    const insertImagePath = vi.fn()
    const insertFilePath = vi.fn()

    dispatchTerminalRichInputDroppedPaths({
      paths: ['image.png'],
      canAttachImages: false,
      insertImagePath,
      insertFilePath
    })

    expect(insertImagePath).not.toHaveBeenCalled()
    expect(insertFilePath).toHaveBeenCalledWith('image.png')
  })
})
