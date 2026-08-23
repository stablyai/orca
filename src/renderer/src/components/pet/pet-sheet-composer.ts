import type { RgbaImage } from './pet-image-cutout'
import { petFloorY } from './pet-image-resample'
import { blankImage, drawTransformed, type RasterTransform } from './pet-raster-transform'
import type { PetLegRig, PetRig } from './pet-rigs'

export const SHEET_COLUMNS = 4
export const SHEET_ROWS = 7

/** Row order must match `bundled-pet-pose-sprite.ts`. */
const ROW = { idle: 0, running: 1, waiting: 2, jumping: 3, falling: 4, downed: 5, rising: 6 }

/** The walk: legs converge past each other on the contact frames and separate on
 *  the passing ones, with `front` alternating which is drawn on top so the
 *  crossing reads as one leg in front of the other. Same cycle the bundled
 *  sheets were generated with. */
const CYCLE = [
  { cross: 1, lift: 0, front: 0, up: 0 },
  { cross: 0, lift: 1, front: 0, up: 1 },
  { cross: 1, lift: 0, front: 1, up: 0 },
  { cross: 0, lift: 1, front: 1, up: 1 }
] as const

/** Builds the seven-row pose sheet for an uploaded body.
 *
 *  Whole-body mode: every pose is a transform of the one silhouette we were
 *  given, because an arbitrary upload has no limbs we can trust. That rules out
 *  a leg cycle, so the walk row leans and bounces instead — it reads as motion
 *  without claiming an anatomy the image may not have. */
export function composeWholeBodySheet(body: RgbaImage, rig: PetRig): RgbaImage {
  if (body.width !== rig.frame.width || body.height !== rig.frame.height) {
    throw new Error(
      `Body is ${body.width}x${body.height} but the rig frame is ${rig.frame.width}x${rig.frame.height}.`
    )
  }
  const { width: fw, height: fh } = rig.frame
  const sheet = blankImage(fw * SHEET_COLUMNS, fh * SHEET_ROWS)
  const floorY = petFloorY(rig)
  const centerX = fw / 2
  const halfWidth = subjectHalfWidth(body)

  for (const [row, frames] of Object.entries(poseRows(rig, floorY, centerX, halfWidth))) {
    frames.forEach((transform, col) => {
      drawTransformed(sheet, body, {
        ...transform,
        translateX: (transform.translateX ?? 0) + col * fw,
        translateY: (transform.translateY ?? 0) + Number(row) * fh,
        clip: cellClip(col * fw, Number(row) * fh, fw, fh)
      })
    })
  }
  return sheet
}

function poseRows(
  rig: PetRig,
  floorY: number,
  centerX: number,
  halfWidth: number
): Record<number, RasterTransform[]> {
  const onFloor = { pivotX: centerX, pivotY: floorY }
  const breathe = rig.idleBreathe

  // Why: tipping about the feet swings the body sideways past its own frame, so
  // each tipped pose lifts by the sine of its angle times half the body width —
  // the same correction the bundled sheets use.
  const tip = (deg: number, extra: Partial<RasterTransform> = {}): RasterTransform => ({
    ...onFloor,
    rotateDeg: deg,
    translateY: -Math.abs(Math.sin((deg * Math.PI) / 180)) * halfWidth,
    ...extra
  })

  return {
    [ROW.idle]: [1, 1 - breathe / 2, 1 - breathe, 1 - breathe / 2].map((sy) => ({
      ...onFloor,
      scaleY: sy,
      scaleX: 1 + (1 - sy) * 0.6
    })),
    // No legs to swing: lean into the direction of travel and bounce instead.
    [ROW.running]: [0, 1, 0, -1].map((phase) => ({
      ...onFloor,
      rotateDeg: phase * 2.5,
      translateY: phase === 0 ? -rig.walk.bobPx : 0
    })),
    [ROW.waiting]: [0, 1, 0, 1].map((tapping) => ({
      ...onFloor,
      rotateDeg: tapping * (rig.waitTapDeg / 6),
      translateY: tapping * -1
    })),
    [ROW.jumping]: [
      { ...onFloor, scaleX: 1.06, scaleY: 0.92 },
      { ...onFloor, scaleX: 0.96, scaleY: 1.06, translateY: -rig.hopPx * 0.7 },
      { ...onFloor, scaleX: 0.99, scaleY: 1.01, translateY: -rig.hopPx },
      { ...onFloor, scaleX: 1.03, scaleY: 0.96 }
    ],
    [ROW.falling]: [-22, -44, -66, -84].map((deg) => tip(deg, { scaleY: 1.03, scaleX: 0.98 })),
    [ROW.downed]: [1, 1.02, 1.03, 1.02].map((sy) => tip(-90, { scaleY: sy, scaleX: 1 / sy })),
    [ROW.rising]: [-90, -62, -26, 4].map((deg, i) => tip(deg, { scaleY: 1 + i * 0.01 }))
  }
}

type SubjectBounds = { x0: number; y0: number; x1: number; y1: number }

function subjectBounds(image: RgbaImage): SubjectBounds | null {
  let x0 = image.width
  let y0 = image.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] < 128) {
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

function subjectHalfWidth(body: RgbaImage): number {
  const bounds = subjectBounds(body)
  return bounds ? (bounds.x1 - bounds.x0 + 1) / 2 : body.width / 2
}

/** Builds the sheet with the legs swung, using a rig detected in the upload.
 *
 *  Same seven rows as whole-body; only the locomotion row differs, because it is
 *  the one pose that needs limbs. Everything else is still a whole-body
 *  transform, so a detected rig that is slightly off degrades to a slightly odd
 *  walk rather than seven broken poses. */
export function composeRiggedSheet(
  body: RgbaImage,
  rig: PetRig,
  legs: readonly [PetLegRig, PetLegRig]
): RgbaImage {
  const sheet = composeWholeBodySheet(body, rig)
  const { width: fw, height: fh } = rig.frame
  const walkRow = ROW.running

  // Clear the leaned frames this row already holds, then redraw them walking.
  for (let col = 0; col < SHEET_COLUMNS; col++) {
    clearCell(sheet, col * fw, walkRow * fh, fw, fh)
  }

  const bodyWithoutLegs = withoutLegs(body, legs)
  const pieces = legs.map((leg, index) => ({
    leg,
    canvas: legPiece(body, leg, index === 0 && leg.mirror === true)
  }))

  CYCLE.forEach((step, col) => {
    const ox = col * fw
    const oy = walkRow * fh - step.up * rig.walk.bobPx
    const clip = cellClip(ox, walkRow * fh, fw, fh)
    drawTransformed(sheet, bodyWithoutLegs, { translateX: ox, translateY: oy, clip })
    const order = step.front === 0 ? [1, 0] : [0, 1]
    for (const index of order) {
      const { leg, canvas } = pieces[index]
      const inward = index === 0 ? 1 : -1
      drawTransformed(sheet, canvas, {
        pivotX: leg.pivot[0],
        pivotY: leg.pivot[1],
        rotateDeg: inward * step.cross * rig.walk.swingDeg,
        translateX: ox + inward * (rig.walk.narrowPx + step.cross * rig.walk.crossPx),
        translateY: oy + (index === step.front ? -step.lift * rig.walk.liftPx : 0),
        clip
      })
    }
  })
  return sheet
}

/** Builds the sheet from the pet's own body with the upload as its head.
 *
 *  The aesthetic is exact here because it IS the pet — only the head is the
 *  user's. That is the trade: it animates fully, but it is the pet wearing a
 *  face rather than the upload brought to life. */
export function composeHeadSwapSheet(head: RgbaImage, petBody: RgbaImage, rig: PetRig): RgbaImage {
  const [hx0, hy0, hx1, hy1] = rig.head
  const merged = blankImage(rig.frame.width, rig.frame.height)
  drawTransformed(merged, petBody, {})
  const bounds = subjectBounds(head)
  if (bounds) {
    const sourceWidth = bounds.x1 - bounds.x0 + 1
    const sourceHeight = bounds.y1 - bounds.y0 + 1
    const scale = Math.min((hx1 - hx0) / sourceWidth, (hy1 - hy0) / sourceHeight)
    const width = Math.round(sourceWidth * scale)
    const height = Math.round(sourceHeight * scale)
    // Why bottom-anchored and centred: the slot's floor is where a head meets a
    // neck, so that edge has to line up; nothing makes either side of it special.
    const x0 = hx0 + Math.round((hx1 - hx0 - width) / 2)
    const y0 = hy1 - height
    // Why this rectangle and not the whole slot: an upload never matches the
    // slot's aspect ratio, so erasing the margins bites a hole around the face.
    clearCell(merged, x0, y0, width, height)
    drawTransformed(merged, head, {
      pivotX: bounds.x0,
      pivotY: bounds.y0,
      scaleX: scale,
      scaleY: scale,
      translateX: x0 - bounds.x0,
      translateY: y0 - bounds.y0,
      clip: cellClip(x0, y0, width, height)
    })
  }
  return composeWholeBodySheet(merged, rig)
}

function cellClip(x: number, y: number, w: number, h: number): RasterTransform['clip'] {
  return { x0: x, y0: y, x1: x + w, y1: y + h }
}

function clearCell(image: RgbaImage, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h && y < image.height; y++) {
    for (let x = x0; x < x0 + w && x < image.width; x++) {
      image.data[(y * image.width + x) * 4 + 3] = 0
    }
  }
}

function withoutLegs(body: RgbaImage, legs: readonly PetLegRig[]): RgbaImage {
  const out = blankImage(body.width, body.height)
  out.data.set(body.data)
  for (const leg of legs) {
    clearCell(out, leg.box[0], leg.box[1], leg.box[2] - leg.box[0], leg.box[3] - leg.box[1])
  }
  return out
}

function legPiece(body: RgbaImage, leg: PetLegRig, mirror: boolean): RgbaImage {
  const out = blankImage(body.width, body.height)
  const [x0, y0, x1, y1] = leg.box
  for (let y = y0; y < y1 && y < body.height; y++) {
    for (let x = x0; x < x1 && x < body.width; x++) {
      // Why: mirroring about the leg's own centre, so it stays where it stands
      // and only the foot changes which way it points.
      const sx = mirror ? x0 + (x1 - 1 - x) : x
      const si = (y * body.width + sx) * 4
      const di = (y * body.width + x) * 4
      out.data[di] = body.data[si]
      out.data[di + 1] = body.data[si + 1]
      out.data[di + 2] = body.data[si + 2]
      out.data[di + 3] = body.data[si + 3]
    }
  }
  return out
}
