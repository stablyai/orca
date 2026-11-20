import { describe, expect, it } from 'vitest'
import { pictureTint, pictureTintFor, rememberPictureTint } from './avatar-picture-tint'

const SIDE = 40

/** A square picture: `edge` around a `face` filling the middle 60%. */
function picture(edge: number[], face: number[]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(SIDE * SIDE * 4)
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const inFace = x >= 8 && x < 32 && y >= 8 && y < 32
      pixels.set(inFace ? face : edge, (y * SIDE + x) * 4)
    }
  }
  return pixels
}

describe('pictureTint', () => {
  it('takes the background around the subject, not the subject', () => {
    expect(pictureTint(picture([180, 210, 160, 255], [200, 30, 30, 255]), SIDE)).toBe('#b4d2a0')
  })

  it('tones a loud or very dark background down to a soft band', () => {
    expect(pictureTint(picture([255, 0, 0, 255], [0, 0, 0, 255]), SIDE)).toBe('#cc3333')
    expect(pictureTint(picture([5, 5, 5, 255], [255, 255, 255, 255]), SIDE)).toBe('#595959')
  })

  it('has no tint for a picture whose edge is transparent', () => {
    expect(pictureTint(picture([0, 0, 0, 0], [200, 30, 30, 255]), SIDE)).toBeNull()
  })
})

describe('pictureTintFor', () => {
  it('returns the tint kept when the picture was taken in', () => {
    rememberPictureTint('UE5HMQ==', '#b4d2a0')
    expect(pictureTintFor('UE5HMQ==')).toBe('#b4d2a0')
    expect(pictureTintFor('T1RIRVI=')).toBeNull()
  })
})
