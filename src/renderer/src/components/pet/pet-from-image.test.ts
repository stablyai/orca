import { describe, expect, it } from 'vitest'
import { buildPetFromImage } from './pet-from-image'
import { blankImage } from './pet-raster-transform'
import { SHEET_COLUMNS, SHEET_ROWS } from './pet-sheet-composer'
import { BUNDLED_PET_RIGS } from './pet-rigs'
import { GREMLIN_PET_ID, DEFAULT_PET_ID } from './pet-models'
import type { RgbaImage } from './pet-image-cutout'

/** A character on transparent background: head over a wider body. */
function uploadedCharacter(width = 60, height = 90): RgbaImage {
  const img = blankImage(width, height)
  const paint = (x: number, y: number): void => {
    const i = (y * width + x) * 4
    img.data[i] = 120
    img.data[i + 1] = 60
    img.data[i + 2] = 200
    img.data[i + 3] = 255
  }
  for (let y = 10; y < 34; y++) {
    for (let x = 24; x < 36; x++) {
      paint(x, y)
    }
  }
  for (let y = 34; y < 78; y++) {
    for (let x = 16; x < 44; x++) {
      paint(x, y)
    }
  }
  return img
}

/** Same shape, but on an opaque noisy background the fill cannot separate. */
function noisyPhoto(width = 60, height = 90): RgbaImage {
  const img = blankImage(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      img.data[i] = (x * 53 + y * 97) % 240
      img.data[i + 1] = 80
      img.data[i + 2] = 120
      img.data[i + 3] = 255
    }
  }
  return img
}

describe('buildPetFromImage', () => {
  it('turns a cut-out character into a sheet the pose descriptor can drive', () => {
    const result = buildPetFromImage(uploadedCharacter(), GREMLIN_PET_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const rig = BUNDLED_PET_RIGS[GREMLIN_PET_ID]
    expect(result.sheet.width).toBe(rig.frame.width * SHEET_COLUMNS)
    expect(result.sheet.height).toBe(rig.frame.height * SHEET_ROWS)
    expect(result.manifest.frame).toEqual({
      width: rig.frame.width,
      height: rig.frame.height
    })
  })

  it('sizes the sheet to whichever aesthetic was chosen', () => {
    const claudino = buildPetFromImage(uploadedCharacter(), DEFAULT_PET_ID)

    expect(claudino.ok).toBe(true)
    if (!claudino.ok) {
      return
    }
    // Claudino's frame is landscape where Gremlin's is portrait.
    expect(claudino.manifest.frame).toEqual({ width: 320, height: 180 })
  })

  it('declares every row the renderer will ask for', () => {
    const result = buildPetFromImage(uploadedCharacter(), GREMLIN_PET_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(Object.keys(result.manifest.animations ?? {}).sort()).toEqual([
      'downed',
      'falling',
      'idle',
      'jumping',
      'rising',
      'running',
      'waiting'
    ])
  })

  it('refuses a photo whose background could not be separated', () => {
    const result = buildPetFromImage(noisyPhoto(), GREMLIN_PET_ID)

    expect(result).toEqual({ ok: false, reason: 'background-not-separable' })
  })

  it('refuses an unknown aesthetic rather than inventing a rig', () => {
    const result = buildPetFromImage(uploadedCharacter(), 'not-a-pet')

    expect(result).toEqual({ ok: false, reason: 'unknown-style' })
  })
})
