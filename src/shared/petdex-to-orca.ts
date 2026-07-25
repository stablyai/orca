/**
 * Convert a Petdex spritesheet + pet.json into an Orca CustomPet bundle record.
 *
 * Petdex sheets use the Codex geometry (192×208 cells, 8×9 atlas = 1536×1872).
 * Orca's import path applies the same CODEX_PET_ANIMATIONS row map — we bake
 * that here so offline seed matches in-app `pet:importPetBundle`.
 */

import type { CustomPet, SpriteAnimation } from './types'
import {
  CODEX_PET_ANIMATIONS,
  CODEX_PET_DEFAULT_ANIMATION,
  CODEX_PET_DEFAULT_COLUMNS,
  CODEX_PET_DEFAULT_FPS,
  CODEX_PET_FRAME
} from './codex-pet-sprite-defaults'

export type PetdexPetJson = {
  id?: string
  displayName?: string
  description?: string
  spritesheetPath?: string
}

export type SheetDimensions = { width: number; height: number }

export class PetdexConvertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PetdexConvertError'
  }
}

/** Codex cell size — Petdex and Orca both use this. */
export const PETDEX_FRAME = CODEX_PET_FRAME

/**
 * Validate sheet is a clean grid of Codex frames and return column/row counts.
 */
export function gridFromSheet(
  dims: SheetDimensions,
  frame: { width: number; height: number } = PETDEX_FRAME
): { columns: number; rows: number } {
  if (dims.width <= 0 || dims.height <= 0) {
    throw new PetdexConvertError(`invalid sheet size ${dims.width}×${dims.height}`)
  }
  if (dims.width % frame.width !== 0 || dims.height % frame.height !== 0) {
    throw new PetdexConvertError(
      `sheet ${dims.width}×${dims.height} is not a clean multiple of frame ${frame.width}×${frame.height}`
    )
  }
  const columns = dims.width / frame.width
  const rows = dims.height / frame.height
  if (columns < 1 || rows < 1) {
    throw new PetdexConvertError(`degenerate grid ${columns}×${rows}`)
  }
  // Why: Orca's CODEX_PET_ANIMATIONS assumes at least 9 rows / 8 cols for full
  // state coverage. Accept taller/wider sheets but require the minimum grid.
  if (columns < CODEX_PET_DEFAULT_COLUMNS) {
    throw new PetdexConvertError(
      `sheet has ${columns} columns; need ≥ ${CODEX_PET_DEFAULT_COLUMNS} for Codex row map`
    )
  }
  if (rows < 9) {
    throw new PetdexConvertError(`sheet has ${rows} rows; need ≥ 9 for Codex state rows`)
  }
  return { columns, rows }
}

export function buildCodexSpriteMeta(
  dims: SheetDimensions,
  animations: Record<string, SpriteAnimation> = CODEX_PET_ANIMATIONS
): NonNullable<CustomPet['sprite']> {
  const { columns, rows } = gridFromSheet(dims)
  for (const [name, anim] of Object.entries(animations)) {
    if (anim.row >= rows) {
      throw new PetdexConvertError(`animation ${name} row ${anim.row} ≥ sheet rows ${rows}`)
    }
    if (anim.frames > columns) {
      throw new PetdexConvertError(
        `animation ${name} frames ${anim.frames} > columns ${columns}`
      )
    }
  }
  return {
    frameWidth: PETDEX_FRAME.width,
    frameHeight: PETDEX_FRAME.height,
    columns,
    rows,
    sheetWidth: dims.width,
    sheetHeight: dims.height,
    fps: CODEX_PET_DEFAULT_FPS,
    defaultAnimation: CODEX_PET_DEFAULT_ANIMATION,
    animations: { ...animations }
  }
}

/**
 * Build the CustomPet index record for a seeded bundle.
 * `id` must be a UUID (Orca storage gate); display label comes from Petdex.
 */
export function buildCustomPetRecord(args: {
  id: string
  label: string
  sheetFileName?: string
  mimeType?: string
  dims: SheetDimensions
}): CustomPet {
  const label = args.label.trim().slice(0, 40) || 'Petdex pet'
  return {
    id: args.id,
    label,
    fileName: args.sheetFileName ?? 'spritesheet.webp',
    mimeType: args.mimeType ?? 'image/webp',
    kind: 'bundle',
    sprite: buildCodexSpriteMeta(args.dims)
  }
}

/** pet.json written beside the spritesheet in the Orca bundle dir. */
export function buildBundlePetJson(args: {
  slug: string
  displayName: string
  description?: string
}): PetdexPetJson {
  return {
    id: args.slug,
    displayName: args.displayName,
    description: args.description ?? `Petdex gallery pet (${args.slug})`,
    spritesheetPath: 'spritesheet.webp'
  }
}
