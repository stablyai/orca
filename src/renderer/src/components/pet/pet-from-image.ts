import { assessCutout, type CutoutRejection } from './pet-cutout-quality'
import { deriveCutout, type RgbaImage } from './pet-image-cutout'
import { petFloorY, resampleSubject } from './pet-image-resample'
import { petRigFor } from './pet-rigs'
import { composeWholeBodySheet, SHEET_COLUMNS } from './pet-sheet-composer'

/** Manifest fields a generated pet writes, matching what the bundle importer
 *  already validates so a generated pet and an imported one are the same thing. */
export type GeneratedPetManifest = {
  spritesheetPath: string
  frame: { width: number; height: number }
  fps: number
  defaultAnimation: string
  animations: Record<string, { row: number; frames: number }>
}

export type BuildPetFailure = CutoutRejection | 'unknown-style'

export type BuildPetResult =
  | { ok: true; sheet: RgbaImage; manifest: GeneratedPetManifest }
  | { ok: false; reason: BuildPetFailure }

const SHEET_FPS = 8
const ROW_ORDER = ['idle', 'running', 'waiting', 'jumping', 'falling', 'downed', 'rising'] as const

/** Turns an uploaded image into a pet in one of the bundled aesthetics.
 *
 *  Deterministic end to end — same image and style give the same bytes — so the
 *  preview the user approves is exactly what gets written. */
export function buildPetFromImage(image: RgbaImage, styleId: string): BuildPetResult {
  const rig = petRigFor(styleId)
  if (!rig) {
    return { ok: false, reason: 'unknown-style' }
  }

  const { mask, source } = deriveCutout(image)
  const verdict = assessCutout(mask, image.width, image.height, source)
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason }
  }

  const body = resampleSubject(image, mask, verdict.bounds, {
    frame: rig.frame,
    floorY: petFloorY(rig)
  })

  return {
    ok: true,
    sheet: composeWholeBodySheet(body, rig),
    manifest: {
      spritesheetPath: 'spritesheet.webp',
      frame: { width: rig.frame.width, height: rig.frame.height },
      fps: SHEET_FPS,
      defaultAnimation: 'idle',
      animations: Object.fromEntries(
        ROW_ORDER.map((name, row) => [name, { row, frames: SHEET_COLUMNS }])
      )
    }
  }
}
