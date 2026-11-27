import { describe, expect, it, vi } from 'vitest'
import { createGlyphInkReader } from './terminal-webgl-atlas-ink-reader'
import { fakeKit, pageWithInk, type ScratchState } from './terminal-webgl-atlas-test-canvas'

const ignoreRead = () => {}

describe('createGlyphInkReader', () => {
  const rect = { x: 0, y: 0, width: 9, height: 18 }

  it('classifies a genuinely blank rect as blank, including a one-pixel-high rect', () => {
    const read = createGlyphInkReader(() => fakeKit())
    expect(read(pageWithInk(false), rect, ignoreRead)).toBe('blank')
    expect(read(pageWithInk(false), { ...rect, height: 1 }, ignoreRead)).toBe('blank')
    expect(read(pageWithInk(true), { ...rect, height: 1 }, ignoreRead)).toBe('ink')
  })

  it.each(['destination', 'source'] as const)(
    'requires a fresh %s control even when the reused scratch previously passed',
    (dropControl) => {
      const scratch: ScratchState = {}
      const kit = fakeKit(scratch)
      const getImageData = vi.spyOn(kit.ctx, 'getImageData')
      const makeKit = vi.fn(() => kit)
      const read = createGlyphInkReader(makeKit)
      expect(read(pageWithInk(false), rect, ignoreRead)).toBe('blank')

      scratch.dropControl = dropControl
      expect(read(pageWithInk(false), rect, ignoreRead)).toBe('unreadable')
      expect(makeKit).toHaveBeenCalledTimes(1)
      const pixels = getImageData.mock.results[1].value.data
      expect([pixels[256 * 4 + 3], pixels[257 * 4 + 3]]).toEqual(
        dropControl === 'destination' ? [0, 255] : [255, 0]
      )
    }
  )

  it('rejects otherwise valid bytes when the scratch context is lost during readback', () => {
    const scratch: ScratchState = {}
    const kit = fakeKit(scratch)
    const getImageData = kit.ctx.getImageData.bind(kit.ctx)
    const readback = vi.spyOn(kit.ctx, 'getImageData').mockImplementation((...args) => {
      const pixels = getImageData(...args)
      scratch.lost = true
      return pixels
    })
    const read = createGlyphInkReader(() => kit)
    const issued = vi.fn()
    expect(read(pageWithInk(false), rect, issued)).toBe('unreadable')
    expect(issued).toHaveBeenCalledTimes(1)
    const pixels = readback.mock.results[0].value.data
    expect([pixels[256 * 4 + 3], pixels[257 * 4 + 3]]).toEqual([255, 255])
  })

  it('never credits ink from an invalid read', () => {
    const read = createGlyphInkReader(() => fakeKit({ dropControl: 'both' }))
    expect(read(pageWithInk(true), rect, ignoreRead)).toBe('unreadable')
  })

  it.each(['a failed control', 'a thrown readback'])('replaces a scratch after %s', (failure) => {
    const failedKit = fakeKit(failure === 'a failed control' ? { dropControl: 'both' } : {})
    if (failure === 'a thrown readback') {
      vi.spyOn(failedKit.ctx, 'getImageData').mockImplementation(() => {
        throw new Error('readback failed')
      })
    }
    const kits = [failedKit, fakeKit()]
    const make = vi.fn(() => kits.shift() ?? null)
    const read = createGlyphInkReader(make)
    expect(read(pageWithInk(false), rect, ignoreRead)).toBe('unreadable')
    expect(make).toHaveBeenCalledTimes(1)
    expect(read(pageWithInk(false), rect, ignoreRead)).toBe('blank')
    expect(make).toHaveBeenCalledTimes(2)
  })

  it.each([
    () => null,
    () => {
      throw new Error('scratch allocation failed')
    }
  ])('reports unavailable when no scratch can be created, without issuing a read', (makeKit) => {
    const read = createGlyphInkReader(makeKit)
    const issued = vi.fn()
    expect(read(pageWithInk(false), rect, issued)).toBe('unavailable')
    expect(issued).not.toHaveBeenCalled()
  })
})
