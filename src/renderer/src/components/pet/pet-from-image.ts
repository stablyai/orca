import { assessCutout, type CutoutRejection } from './pet-cutout-quality'
import { deriveCutout, type RgbaImage } from './pet-image-cutout'
import { petFloorY, resampleSubject } from './pet-image-resample'
import { petRigFor } from './pet-rigs'
import {
  composeHeadSwapSheet,
  composeRiggedSheet,
  composeWholeBodySheet,
  SHEET_COLUMNS
} from './pet-sheet-composer'
import { detectLegs } from './pet-rig-detection'

/** Manifest fields a generated pet writes, matching what the bundle importer
 *  already validates so a generated pet and an imported one are the same thing. */
export type GeneratedPetManifest = {
  spritesheetPath: string
  frame: { width: number; height: number }
  fps: number
  defaultAnimation: string
  animations: Record<string, { row: number; frames: number }>
}

/** Why: the list is the source of the type, not a copy of it. A new reason
 *  added here fails the message switch at compile time and the exhaustiveness
 *  test at run time, so it cannot ship without an explanation for the user. */
export const BUILD_PET_FAILURES = [
  'background-not-separable',
  'subject-not-found',
  'subject-fragmented',
  'full-bleed',
  'no-character-shape',
  'unknown-style',
  'style-artwork-unavailable'
] as const satisfies readonly (CutoutRejection | 'unknown-style' | 'style-artwork-unavailable')[]

export type BuildPetFailure = (typeof BUILD_PET_FAILURES)[number]

/** How the upload becomes a pet. `whole-body` is the only one that works for
 *  any image; the other two can fail and say so. */
export type PetBuildMode = 'whole-body' | 'rigged' | 'head-swap'

export type BuildPetOptions = {
  mode?: PetBuildMode
  /** The chosen pet's own artwork, needed only by `head-swap`. */
  petBody?: RgbaImage | null
}

export type BuildPetResult =
  | {
      ok: true
      sheet: RgbaImage
      manifest: GeneratedPetManifest
      /** What was actually built — not always what was asked for. */
      mode: PetBuildMode
      requestedMode: PetBuildMode
    }
  | { ok: false; reason: BuildPetFailure }

const SHEET_FPS = 8
const ROW_ORDER = ['idle', 'running', 'waiting', 'jumping', 'falling', 'downed', 'rising'] as const

/** Turns an uploaded image into a pet in one of the bundled aesthetics.
 *
 *  Deterministic end to end — same image and style give the same bytes — so the
 *  preview the user approves is exactly what gets written. */
export function buildPetFromImage(
  image: RgbaImage,
  styleId: string,
  options: BuildPetOptions = {}
): BuildPetResult {
  const requestedMode = options.mode ?? 'whole-body'
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

  let mode: PetBuildMode = requestedMode
  let sheet: RgbaImage
  if (requestedMode === 'head-swap') {
    // Why: the pet's own artwork is the body here. Without it there is nothing
    // to swap a head onto, and silently building something else would hand the
    // user a pet they did not ask for.
    const petBody = options.petBody
    if (!petBody) {
      return { ok: false, reason: 'style-artwork-unavailable' }
    }
    sheet = composeHeadSwapSheet(body, petBody, rig)
  } else if (requestedMode === 'rigged') {
    const detected = detectLegs(body)
    if (detected) {
      sheet = composeRiggedSheet(body, rig, detected.legs)
    } else {
      // Why: degrade rather than refuse. A wrong rig tears a seam through the
      // middle of the pet in every walk frame; whole-body just slides.
      mode = 'whole-body'
      sheet = composeWholeBodySheet(body, rig)
    }
  } else {
    sheet = composeWholeBodySheet(body, rig)
  }

  return {
    ok: true,
    mode,
    requestedMode,
    sheet,
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
