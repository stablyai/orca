import { describe, expect, it } from 'vitest'
import { composeWholeBodySheet, SHEET_COLUMNS, SHEET_ROWS } from './pet-sheet-composer'
import { blankImage } from './pet-raster-transform'
import { BUNDLED_PET_RIGS } from './pet-rigs'
import { GREMLIN_PET_ID } from './pet-models'
import type { RgbaImage } from './pet-image-cutout'

const rig = BUNDLED_PET_RIGS[GREMLIN_PET_ID]

/** A character-shaped body already sitting on the rig's floor line. */
function body(): RgbaImage {
  const img = blankImage(rig.frame.width, rig.frame.height)
  const floor = 300
  for (let y = floor - 200; y < floor; y++) {
    const half = y < floor - 150 ? 20 : 45 // narrow head over a wider body
    for (let x = 126 - half; x < 126 + half; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 90
      img.data[i + 1] = 160
      img.data[i + 2] = 70
      img.data[i + 3] = 255
    }
  }
  return img
}

function cell(sheet: RgbaImage, col: number, row: number): RgbaImage {
  const { width: w, height: h } = rig.frame
  const out = blankImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((row * h + y) * sheet.width + (col * w + x)) * 4
      const di = (y * w + x) * 4
      out.data[di] = sheet.data[si]
      out.data[di + 1] = sheet.data[si + 1]
      out.data[di + 2] = sheet.data[si + 2]
      out.data[di + 3] = sheet.data[si + 3]
    }
  }
  return out
}

function fingerprint(img: RgbaImage): string {
  let opaque = 0
  let sumY = 0
  let minY = img.height
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) {
        continue
      }
      opaque++
      sumY += y
      if (y < minY) {
        minY = y
      }
    }
  }
  return `${opaque}:${Math.round(sumY / Math.max(1, opaque))}:${minY}`
}

describe('composeWholeBodySheet', () => {
  it('lays out the same grid the pose descriptor expects', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    expect(sheet.width).toBe(rig.frame.width * SHEET_COLUMNS)
    expect(sheet.height).toBe(rig.frame.height * SHEET_ROWS)
    expect(SHEET_COLUMNS).toBe(4)
    expect(SHEET_ROWS).toBe(7)
  })

  it('fills every cell — a blank frame reads as a broken animation', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    for (let row = 0; row < SHEET_ROWS; row++) {
      for (let col = 0; col < SHEET_COLUMNS; col++) {
        const opaque = fingerprint(cell(sheet, col, row)).split(':')[0]
        expect(Number(opaque), `row ${row} col ${col} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('moves within a row, so no row is four copies of one frame', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    for (let row = 0; row < SHEET_ROWS; row++) {
      const prints = new Set(
        Array.from({ length: SHEET_COLUMNS }, (_, col) => fingerprint(cell(sheet, col, row)))
      )
      expect(prints.size, `row ${row} never changes`).toBeGreaterThan(1)
    }
  })

  it('keeps the walking row upright and the downed row on its side', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    const standing = cell(sheet, 0, 1)
    const downed = cell(sheet, 0, 5)

    // Lying down puts the mass lower and spreads it wider than standing does.
    expect(Number(fingerprint(downed).split(':')[2])).toBeGreaterThan(
      Number(fingerprint(standing).split(':')[2])
    )
  })

  it('refuses a body that does not match the rig frame', () => {
    const wrongSize = blankImage(10, 10)

    expect(() => composeWholeBodySheet(wrongSize, rig)).toThrow(/frame/i)
  })
})
