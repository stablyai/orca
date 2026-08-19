import { describe, expect, it } from 'vitest'
import { poseSpriteFrom, type BundledPetPoses } from './bundled-pet-pose-sprite'

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
    expect(sprite.rows).toBe(4)
    expect(sprite.sheetWidth).toBe(1008)
    expect(sprite.sheetHeight).toBe(1280)
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
      jumping: 3
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
})
