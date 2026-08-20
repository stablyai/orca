import { describe, expect, it } from 'vitest'
import { buildPetFromImage } from './pet-from-image'
import { blankImage } from './pet-raster-transform'
import { SHEET_COLUMNS, SHEET_ROWS } from './pet-sheet-composer'
import { BUNDLED_PET_RIGS } from './pet-rigs'
import { GREMLIN_PET_ID, DEFAULT_PET_ID } from './pet-models'
import { BACKGROUND_TOLERANCE, type RgbaImage } from './pet-image-cutout'

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

/** Head, torso and two legs — the only shape a rig can honestly be found in. */
function bipedUpload(): RgbaImage {
  const img = blankImage(60, 100)
  const paint = (x: number, y: number): void => {
    const i = (y * 60 + x) * 4
    img.data[i] = 120
    img.data[i + 1] = 60
    img.data[i + 2] = 200
    img.data[i + 3] = 255
  }
  for (let y = 8; y < 30; y++) {
    for (let x = 24; x < 36; x++) {
      paint(x, y)
    }
  }
  for (let y = 30; y < 62; y++) {
    for (let x = 18; x < 42; x++) {
      paint(x, y)
    }
  }
  for (let y = 62; y < 92; y++) {
    for (let x = 21; x < 27; x++) {
      paint(x, y)
    }
    for (let x = 33; x < 39; x++) {
      paint(x, y)
    }
  }
  return img
}

/** Stands in for a bundled pet's artwork: a green slab filling its frame. */
function fakePetBody(width: number, height: number): RgbaImage {
  const img = blankImage(width, height)
  for (let p = 0; p < width * height; p++) {
    img.data[p * 4] = 20
    img.data[p * 4 + 1] = 200
    img.data[p * 4 + 2] = 20
    img.data[p * 4 + 3] = 255
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

  it('defaults to whole-body, which works for any image', () => {
    const result = buildPetFromImage(uploadedCharacter(), GREMLIN_PET_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mode).toBe('whole-body')
    }
  })

  it('rigs the legs when asked and the silhouette has them', () => {
    const result = buildPetFromImage(bipedUpload(), GREMLIN_PET_ID, { mode: 'rigged' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mode).toBe('rigged')
    }
  })

  it('falls back to whole-body when the silhouette has no legs to rig', () => {
    // A pillar: rigging it would tear a seam down an imaginary middle.
    const pillar = blankImage(60, 90)
    for (let y = 8; y < 84; y++) {
      for (let x = 20; x < 40; x++) {
        const i = (y * 60 + x) * 4
        pillar.data[i] = 90
        pillar.data[i + 1] = 90
        pillar.data[i + 2] = 160
        pillar.data[i + 3] = 255
      }
    }

    const result = buildPetFromImage(pillar, GREMLIN_PET_ID, { mode: 'rigged' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Reported, not silent: the dialog has to be able to say the rig failed.
      expect(result.mode).toBe('whole-body')
      expect(result.requestedMode).toBe('rigged')
    }
  })

  it('drops the upload onto the pet body in head-swap mode', () => {
    const rig = BUNDLED_PET_RIGS[GREMLIN_PET_ID]
    const result = buildPetFromImage(uploadedCharacter(), GREMLIN_PET_ID, {
      mode: 'head-swap',
      petBody: fakePetBody(rig.frame.width, rig.frame.height)
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.mode).toBe('head-swap')
    // Both must be present: the pet's green body proves the aesthetic is its
    // own, the upload's purple proves the head was actually swapped in.
    expect(countMatching(result.sheet, (r, g, b) => g > 150 && r < 90 && b < 90)).toBeGreaterThan(0)
    expect(countMatching(result.sheet, (r, g, b) => b > 150 && r > 90 && g < 100)).toBeGreaterThan(
      0
    )
  })

  it('needs the pet artwork to build a head swap, and says so without it', () => {
    const result = buildPetFromImage(uploadedCharacter(), GREMLIN_PET_ID, {
      mode: 'head-swap',
      petBody: null
    })

    expect(result).toEqual({ ok: false, reason: 'style-artwork-unavailable' })
  })
})

function countMatching(
  image: { data: Uint8ClampedArray; width: number; height: number },
  match: (r: number, g: number, b: number) => boolean
): number {
  let count = 0
  for (let p = 0; p < image.width * image.height; p++) {
    if (image.data[p * 4 + 3] < 128) {
      continue
    }
    if (match(image.data[p * 4], image.data[p * 4 + 1], image.data[p * 4 + 2])) {
      count++
    }
  }
  return count
}

/** A busy left half that no corner fill can clear, and a clean right half with
 *  a character on it — the exact case a manual crop exists to rescue. */
function halfBusyPhoto(): RgbaImage {
  const w = 80
  const h = 80
  const img = blankImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const busy = x < 40
      // Deterministic clutter, far outside the flood tolerance of its neighbours.
      const noise = ((x * 37 + y * 91) % 5) * 60
      img.data[i] = busy ? noise : 245
      img.data[i + 1] = busy ? (noise + 80) % 256 : 245
      img.data[i + 2] = busy ? (noise + 160) % 256 : 245
      img.data[i + 3] = 255
    }
  }
  for (let y = 12; y < 30; y++) {
    for (let x = 54; x < 66; x++) {
      const i = (y * w + x) * 4
      img.data[i] = 30
      img.data[i + 1] = 30
      img.data[i + 2] = 30
    }
  }
  for (let y = 30; y < 70; y++) {
    for (let x = 48; x < 72; x++) {
      const i = (y * w + x) * 4
      img.data[i] = 30
      img.data[i + 1] = 30
      img.data[i + 2] = 30
    }
  }
  return img
}

describe('buildPetFromImage crop', () => {
  /** Colours in the sheet that are not the character's own flat 30/30/30. */
  const clutterPixels = (sheet: RgbaImage): number => {
    let count = 0
    for (let p = 0; p < sheet.width * sheet.height; p++) {
      const i = p * 4
      if (sheet.data[i + 3] < 128) {
        continue
      }
      if (sheet.data[i] !== 30 || sheet.data[i + 1] !== 30 || sheet.data[i + 2] !== 30) {
        count++
      }
    }
    return count
  }

  it('builds the pet out of the clutter when it is left in frame', () => {
    const result = buildPetFromImage(halfBusyPhoto(), DEFAULT_PET_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(clutterPixels(result.sheet)).toBeGreaterThan(0)
    }
  })

  it('builds the pet out of the character alone once the user frames it', () => {
    const result = buildPetFromImage(halfBusyPhoto(), DEFAULT_PET_ID, {
      crop: { x: 42, y: 4, width: 36, height: 72 }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(clutterPixels(result.sheet)).toBe(0)
    }
  })

  it('ignores a crop that covers the whole image', () => {
    const plain = uploadedCharacter()
    const cropped = buildPetFromImage(plain, DEFAULT_PET_ID, {
      crop: { x: 0, y: 0, width: plain.width, height: plain.height }
    })

    expect(cropped).toEqual(buildPetFromImage(plain, DEFAULT_PET_ID))
  })
})

/** A steep grey gradient behind a flat character: each corner fill stops well
 *  short of the middle, leaving a band of background stuck to the subject. */
function gradientBackdrop(): RgbaImage {
  const w = 80
  const h = 80
  const img = blankImage(w, h)
  for (let y = 0; y < h; y++) {
    const shade = 100 + Math.round((y * 155) / (h - 1))
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      img.data[i] = shade
      img.data[i + 1] = shade
      img.data[i + 2] = shade
      img.data[i + 3] = 255
    }
  }
  // Far enough from both corner colours to survive a fill wide enough to span
  // the whole gradient — otherwise no tolerance could ever rescue this image.
  // A silhouette, not a slab: the quality gate refuses plain rectangles.
  const paint = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4
        img.data[i] = 255
        img.data[i + 1] = 60
        img.data[i + 2] = 60
      }
    }
  }
  paint(35, 45, 22, 36)
  paint(30, 50, 36, 54)
  paint(33, 38, 54, 66)
  paint(42, 47, 54, 66)
  return img
}

describe('buildPetFromImage background tolerance', () => {
  /** The backdrop is grey; the character never is. */
  const greyPixels = (sheet: RgbaImage): number => {
    let count = 0
    for (let p = 0; p < sheet.width * sheet.height; p++) {
      const i = p * 4
      if (
        sheet.data[i + 3] >= 128 &&
        sheet.data[i] === sheet.data[i + 1] &&
        sheet.data[i + 1] === sheet.data[i + 2]
      ) {
        count++
      }
    }
    return count
  }

  it('refuses a gradient backdrop no corner fill can reach across', () => {
    const result = buildPetFromImage(gradientBackdrop(), DEFAULT_PET_ID)

    expect(result.ok).toBe(false)
  })

  it('clears the gradient once the user widens the tolerance', () => {
    const result = buildPetFromImage(gradientBackdrop(), DEFAULT_PET_ID, {
      backgroundTolerance: 80
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(greyPixels(result.sheet)).toBe(0)
    }
  })

  it('matches the untouched pipeline at the default tolerance', () => {
    const plain = uploadedCharacter()

    expect(
      buildPetFromImage(plain, DEFAULT_PET_ID, {
        backgroundTolerance: BACKGROUND_TOLERANCE.default
      })
    ).toEqual(buildPetFromImage(plain, DEFAULT_PET_ID))
  })
})
