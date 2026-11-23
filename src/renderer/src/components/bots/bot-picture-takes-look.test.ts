import { describe, expect, it } from 'vitest'
import { pictureTakesLook, type BotPictureCustom } from './BotPicturePicker'

const image: BotPictureCustom = {
  src: 'data:image/png;base64,AAAA',
  fallback: '',
  after: 0,
  description: ''
}

describe('pictureTakesLook', () => {
  it('holds for mascots, retired ones included, and not for an uploaded or generated image', () => {
    expect(pictureTakesLook({ kind: 'mascot', index: 0 }, image)).toBe(true)
    expect(pictureTakesLook({ kind: 'custom' }, { ...image, mascot: 'S2' })).toBe(true)
    expect(pictureTakesLook({ kind: 'custom' }, image)).toBe(false)
  })
})
