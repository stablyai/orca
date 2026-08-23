import { describe, expect, it } from 'vitest'
import { poseSpriteFrom, type BundledPetPoses } from './bundled-pet-pose-sprite'
import { PET_RISING_MS } from './usePetFallToLane'

const poses: BundledPetPoses = {
  url: 'poses.webp',
  frameWidth: 252,
  frameHeight: 320,
  frames: 4,
  fps: 8
}

describe('poseSpriteFrom', () => {
  it('describes the sheet geometry the sprite renderer steps through', () => {
    const sprite = poseSpriteFrom(poses)

    expect(sprite.frameWidth).toBe(252)
    expect(sprite.frameHeight).toBe(320)
    expect(sprite.columns).toBe(4)
    expect(sprite.rows).toBe(7)
    expect(sprite.sheetWidth).toBe(1008)
    expect(sprite.sheetHeight).toBe(2240)
    expect(sprite.defaultAnimation).toBe('idle')
  })

  it('maps every live pet state to a row, leaving no state on the fallback', () => {
    const sprite = poseSpriteFrom(poses)
    const rows = Object.fromEntries(
      Object.entries(sprite.animations ?? {}).map(([name, a]) => [name, a.row])
    )

    expect(rows).toEqual({
      idle: 0,
      running: 1,
      'running-left': 1,
      'running-right': 1,
      waiting: 2,
      review: 2,
      jumping: 3,
      falling: 4,
      downed: 5,
      rising: 6
    })
  })

  it('paces breathing slower than running so the idle does not look frantic', () => {
    const sprite = poseSpriteFrom(poses)
    const hold = (name: string): number =>
      sprite.animations?.[name]?.frameDurationsMs?.[0] ?? Number.NaN

    expect(hold('idle')).toBeGreaterThan(hold('running'))
    expect(hold('waiting')).toBeGreaterThan(hold('running'))
    expect(hold('jumping')).toBeLessThanOrEqual(hold('running'))
  })

  it('paces getting up over the full rise so it plays exactly once', () => {
    const sprite = poseSpriteFrom(poses)
    const rise = sprite.animations?.rising
    const total = (rise?.frameDurationsMs ?? []).reduce((a, b) => a + b, 0)

    expect(total).toBe(PET_RISING_MS)
  })
})
