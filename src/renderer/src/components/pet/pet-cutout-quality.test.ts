import { describe, expect, it } from 'vitest'
import { assessCutout } from './pet-cutout-quality'

const W = 40
const H = 40

/** Builds an opacity mask from a predicate, so tests read as shapes not arrays. */
function mask(opaque: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      m[y * W + x] = opaque(x, y) ? 255 : 0
    }
  }
  return m
}

/** A plausible subject: head on top, wider body below, clear of every edge. */
const character = mask((x, y) => {
  if (y >= 8 && y < 18) {
    return x >= 16 && x < 24 // head
  }
  if (y >= 18 && y < 32) {
    return x >= 12 && x < 28 // body
  }
  return false
})

describe('assessCutout', () => {
  it('accepts a subject that stands clear of the background', () => {
    const verdict = assessCutout(character, W, H, 'derived')

    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.bounds).toEqual({ x0: 12, y0: 8, x1: 27, y1: 31 })
    }
  })

  it('rejects an image where nothing was removed', () => {
    const verdict = assessCutout(
      mask(() => true),
      W,
      H,
      'derived'
    )

    expect(verdict).toEqual({ ok: false, reason: 'background-not-separable' })
  })

  it('rejects an image where the fill ate the subject', () => {
    const verdict = assessCutout(
      mask((x, y) => x < 3 && y < 3),
      W,
      H,
      'derived'
    )

    expect(verdict).toEqual({ ok: false, reason: 'subject-not-found' })
  })

  it('rejects scattered noise that never adds up to one subject', () => {
    // Five separate blobs, none dominant.
    const verdict = assessCutout(
      mask((x, y) => x % 8 < 4 && y % 8 < 4 && y > 10 && y < 30),
      W,
      H,
      'derived'
    )

    expect(verdict).toEqual({ ok: false, reason: 'subject-fragmented' })
  })

  it('rejects a full-bleed photo that touches every edge', () => {
    const verdict = assessCutout(
      mask((x, y) => x < 4 || x >= W - 4 || y < 4 || y >= H - 4),
      W,
      H,
      'derived'
    )

    expect(verdict).toEqual({ ok: false, reason: 'full-bleed' })
  })

  it('rejects a rectangular slab where no character is distinguishable', () => {
    // Every row the same width: a chunk of background the fill could not remove.
    const verdict = assessCutout(
      mask((x, y) => y >= 26 && y < 32 && x >= 6 && x < 34),
      W,
      H,
      'derived'
    )

    expect(verdict).toEqual({ ok: false, reason: 'no-character-shape' })
  })

  it('never second-guesses a cutout the image already carried', () => {
    // Someone else's alpha: only a genuinely empty image is refused.
    const wouldFail = mask(() => true)

    expect(assessCutout(wouldFail, W, H, 'alpha').ok).toBe(true)
    expect(
      assessCutout(
        mask(() => false),
        W,
        H,
        'alpha'
      )
    ).toEqual({
      ok: false,
      reason: 'subject-not-found'
    })
  })
})
