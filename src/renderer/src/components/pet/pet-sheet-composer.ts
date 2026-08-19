import type { RgbaImage } from './pet-image-cutout'
import { petFloorY } from './pet-image-resample'
import { blankImage, drawTransformed, type RasterTransform } from './pet-raster-transform'
import type { PetRig } from './pet-rigs'

export const SHEET_COLUMNS = 4
export const SHEET_ROWS = 7

/** Row order must match `bundled-pet-pose-sprite.ts`. */
const ROW = { idle: 0, running: 1, waiting: 2, jumping: 3, falling: 4, downed: 5, rising: 6 }

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
        translateY: (transform.translateY ?? 0) + Number(row) * fh
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

function subjectHalfWidth(body: RgbaImage): number {
  let minX = body.width
  let maxX = -1
  for (let y = 0; y < body.height; y++) {
    for (let x = 0; x < body.width; x++) {
      if (body.data[(y * body.width + x) * 4 + 3] < 128) {
        continue
      }
      if (x < minX) {
        minX = x
      }
      if (x > maxX) {
        maxX = x
      }
    }
  }
  return maxX < 0 ? body.width / 2 : (maxX - minX + 1) / 2
}
