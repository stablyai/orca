import { describe, expect, it } from 'vitest'
import {
  composeHeadSwapSheet,
  composeRiggedSheet,
  composeWholeBodySheet,
  SHEET_COLUMNS,
  SHEET_ROWS
} from './pet-sheet-composer'
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

const DOWNED_ROW = 5

/** Opaque pixels in the right-hand quarter of a cell, where a neighbour's
 *  leftward-swinging pose lands. */
function rightEdgeOpaque(img: RgbaImage): number {
  let count = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = Math.floor(img.width * 0.75); x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] >= 128) {
        count++
      }
    }
  }
  return count
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

  it('clips a pose that swings past its own frame instead of painting the neighbour', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    // Downed columns 1 and 3 are the same transform, so any difference between
    // them is column 2's rotated body reaching left into column 1's cell.
    expect(cell(sheet, 1, DOWNED_ROW).data).toEqual(cell(sheet, 3, DOWNED_ROW).data)
  })

  it('leaves a cell blank where only its neighbour has ink to give it', () => {
    const sheet = composeWholeBodySheet(body(), rig)

    // A downed pose lies leftward from the feet at the frame centre, so its own
    // right-hand quarter is empty; anything there came from the column beside it.
    expect(rightEdgeOpaque(cell(sheet, 0, DOWNED_ROW))).toBe(0)
  })
})

/** A subject that reaches the top of its frame, which is what `resampleSubject`
 *  produces for any upload tall enough to be limited by the floor line. */
function tallBody(): RgbaImage {
  const img = blankImage(rig.frame.width, rig.frame.height)
  for (let y = 0; y < 300; y++) {
    for (let x = 81; x < 171; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 90
      img.data[i + 1] = 160
      img.data[i + 2] = 70
      img.data[i + 3] = 255
    }
  }
  return img
}

describe('composeRiggedSheet', () => {
  it('touches only the walking row, so the bob cannot draw into the row above', () => {
    const subject = tallBody()
    const plain = composeWholeBodySheet(subject, rig)
    const walked = composeRiggedSheet(subject, rig, rig.legs)

    for (let row = 0; row < SHEET_ROWS; row++) {
      if (row === 1) {
        continue
      }
      for (let col = 0; col < SHEET_COLUMNS; col++) {
        expect(cell(walked, col, row).data, `row ${row} col ${col} was overwritten`).toEqual(
          cell(plain, col, row).data
        )
      }
    }
  })
})

/** The pet's own artwork: a solid slab covering the head slot and well past it. */
function petArtwork(): RgbaImage {
  const img = blankImage(rig.frame.width, rig.frame.height)
  for (let y = 20; y < 300; y++) {
    for (let x = 60; x < 210; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 200
      img.data[i + 1] = 60
      img.data[i + 2] = 60
      img.data[i + 3] = 255
    }
  }
  return img
}

/** What `resampleSubject` hands the composer: a tall subject standing on the
 *  floor line, filling the frame rather than the head slot. */
function upload(): RgbaImage {
  const img = blankImage(rig.frame.width, rig.frame.height)
  for (let y = 100; y < 300; y++) {
    for (let x = 81; x < 171; x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = 60
      img.data[i + 1] = 60
      img.data[i + 2] = 200
      img.data[i + 3] = 255
    }
  }
  return img
}

/** Bounds of the upload's own colour, so its placement can be measured apart
 *  from the pet it was dropped onto. */
function uploadBounds(img: RgbaImage): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = img.width
  let y0 = img.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      if (img.data[i + 3] < 128 || img.data[i + 2] <= img.data[i]) {
        continue
      }
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

describe('composeHeadSwapSheet', () => {
  // The idle row's first frame is an untransformed pose, so it is the merged
  // body verbatim.
  const merged = (): RgbaImage => cell(composeHeadSwapSheet(upload(), petArtwork(), rig), 0, 0)

  it('puts the upload inside the head slot rather than over the whole pet', () => {
    const [hx0, hy0, hx1, hy1] = rig.head

    const placed = uploadBounds(merged())

    expect(placed).not.toBeNull()
    expect(placed?.x0).toBeGreaterThanOrEqual(hx0)
    expect(placed?.y0).toBeGreaterThanOrEqual(hy0)
    expect(placed?.x1).toBeLessThan(hx1)
    expect(placed?.y1).toBeLessThan(hy1)
  })

  it('preserves the upload’s aspect ratio while filling the slot’s tighter axis', () => {
    const [hx0, , hx1, hy1] = rig.head
    const slotWidth = hx1 - hx0
    const source = uploadBounds(upload())!
    const sourceRatio = (source.x1 - source.x0 + 1) / (source.y1 - source.y0 + 1)

    const placed = uploadBounds(merged())!
    const width = placed.x1 - placed.x0 + 1
    const height = placed.y1 - placed.y0 + 1

    expect(width / height).toBeCloseTo(sourceRatio, 1)
    // Taller than the slot is wide, so height is the binding axis and the upload
    // rests on the slot's floor — where a head meets a neck.
    expect(width).toBeLessThan(slotWidth)
    expect(placed.y1).toBe(hy1 - 1)
  })

  it('erases only the rectangle the upload fills, leaving the pet at the margins', () => {
    const [hx0, hy0, hx1, hy1] = rig.head
    const frame = merged()
    const placed = uploadBounds(frame)!

    let holes = 0
    for (let y = hy0; y < hy1; y++) {
      for (let x = hx0; x < hx1; x++) {
        const inside = x >= placed.x0 && x <= placed.x1 && y >= placed.y0 && y <= placed.y1
        if (!inside && frame.data[(y * frame.width + x) * 4 + 3] < 128) {
          holes++
        }
      }
    }

    expect(holes).toBe(0)
  })

  it('still shows the pet everywhere the upload is not', () => {
    const [hx0, , hx1, hy1] = rig.head
    const frame = merged()

    // A pixel well outside the slot belongs to the pet, in the pet's colour.
    const i = ((hy1 + 40) * frame.width + (hx0 + 20)) * 4
    expect(frame.data[i + 3]).toBe(255)
    expect(frame.data[i]).toBeGreaterThan(frame.data[i + 2])
    expect(hx1).toBeGreaterThan(hx0)
  })
})
