import { describe, expect, it } from 'vitest'
import {
  CODEX_PET_ANIMATIONS,
  CODEX_PET_DEFAULT_COLUMNS,
  applyCodexSpriteTimingDefaults,
  type CustomPetSprite
} from './codex-pet-sprite-defaults'

function legacyCodexSprite(): CustomPetSprite {
  return {
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
    sheetWidth: 1536,
    sheetHeight: 1872,
    fps: 8,
    defaultAnimation: 'idle',
    animations: {
      idle: { row: 0, frames: 6 },
      'running-right': { row: 1, frames: 8 },
      'running-left': { row: 2, frames: 8 },
      waving: { row: 3, frames: 4 },
      jumping: { row: 4, frames: 5 },
      failed: { row: 5, frames: 8 },
      waiting: { row: 6, frames: 6 },
      running: { row: 7, frames: 6 },
      review: { row: 8, frames: 6 }
    }
  }
}

describe('CODEX_PET_ANIMATIONS', () => {
  it('ships per-frame durations matching each frame count', () => {
    for (const [name, anim] of Object.entries(CODEX_PET_ANIMATIONS)) {
      expect(anim.frameDurationsMs, name).toBeDefined()
      expect(anim.frameDurationsMs, name).toHaveLength(anim.frames)
      for (const ms of anim.frameDurationsMs ?? []) {
        expect(ms, name).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the Codex ambient idle cycle at 6.6 seconds', () => {
    const total = (CODEX_PET_ANIMATIONS.idle.frameDurationsMs ?? []).reduce(
      (sum, ms) => sum + ms,
      0
    )
    expect(total).toBe(6600)
  })
})

describe('applyCodexSpriteTimingDefaults', () => {
  it('upgrades the legacy baked-default fingerprint with durations', () => {
    const upgraded = applyCodexSpriteTimingDefaults(legacyCodexSprite())
    expect(upgraded.animations).toEqual(CODEX_PET_ANIMATIONS)
    expect(upgraded.animations?.idle.frameDurationsMs).toEqual([1680, 660, 660, 840, 840, 1920])
  })

  it('leaves hand-authored animation layouts untouched', () => {
    const sprite = legacyCodexSprite()
    sprite.animations = { blink: { row: 0, frames: 2 } }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves sprites with a non-default fps untouched', () => {
    const sprite = { ...legacyCodexSprite(), fps: 4 }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves sprites that already declare durations untouched', () => {
    const sprite = legacyCodexSprite()
    sprite.animations = {
      ...sprite.animations,
      idle: { row: 0, frames: 6, frameDurationsMs: [100, 100, 100, 100, 100, 100] }
    }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves sprites without animations untouched', () => {
    const sprite = { ...legacyCodexSprite(), animations: undefined }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves a hand-authored 8 fps sheet that only reuses the Codex row map untouched', () => {
    // Same fps + nine Codex rows, but non-Codex frame geometry — must not retime.
    const sprite: CustomPetSprite = {
      ...legacyCodexSprite(),
      frameWidth: 32,
      frameHeight: 32,
      sheetWidth: CODEX_PET_DEFAULT_COLUMNS * 32,
      sheetHeight: 9 * 32
    }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves a sheet with a non-idle default animation untouched', () => {
    const sprite = { ...legacyCodexSprite(), defaultAnimation: 'running' }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('leaves a sheet with a non-Codex column count untouched', () => {
    const sprite = { ...legacyCodexSprite(), columns: CODEX_PET_DEFAULT_COLUMNS + 2 }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })

  it('does not throw on a corrupted animation entry that matches the outer fingerprint', () => {
    const sprite = legacyCodexSprite()
    // Corrupt persisted entries must fail fingerprint matching without throwing.
    sprite.animations = { ...sprite.animations, idle: null as never }
    expect(applyCodexSpriteTimingDefaults(sprite)).toBe(sprite)
  })
})
