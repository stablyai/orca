import { describe, expect, it } from 'vitest'
import { walkSpriteFrom } from './bundled-pet-walk-sprite'

describe('walkSpriteFrom', () => {
  it('describes the strip as a single-row sheet the sprite renderer can step', () => {
    const sprite = walkSpriteFrom({
      url: 'walk.webp',
      frameWidth: 252,
      frameHeight: 320,
      frames: 4,
      fps: 8
    })

    expect(sprite).toEqual({
      frameWidth: 252,
      frameHeight: 320,
      columns: 4,
      rows: 1,
      sheetWidth: 1008,
      sheetHeight: 320,
      fps: 8,
      defaultAnimation: 'walk',
      animations: { walk: { row: 0, frames: 4 } }
    })
  })

  it('resolves any live pet state to the one strip it has', () => {
    const sprite = walkSpriteFrom({
      url: 'walk.webp',
      frameWidth: 320,
      frameHeight: 180,
      frames: 4,
      fps: 8
    })

    // SpriteFrame falls back to defaultAnimation when the requested state is
    // absent, so 'running'/'waiting'/'review' all land on the walk strip.
    expect(sprite.animations?.[sprite.defaultAnimation ?? '']).toEqual({ row: 0, frames: 4 })
  })
})
