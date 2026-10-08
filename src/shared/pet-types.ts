export const PET_SIZE_MIN = 60
export const PET_SIZE_MAX = 360
export const PET_SIZE_DEFAULT = 180

// Why shared: main validates `pet.select` against the same ids the renderer ships art for.
export const DEFAULT_PET_ID = 'claude-the-mage'
export const OPENCODE_PET_ID = 'opencode-the-rogue'
export const GREMLIN_PET_ID = 'gremlin-the-trickster'
export const BUNDLED_PET_IDS = [DEFAULT_PET_ID, OPENCODE_PET_ID, GREMLIN_PET_ID] as const
export type BundledPetId = (typeof BUNDLED_PET_IDS)[number]

export function isBundledPetId(id: string | undefined): id is BundledPetId {
  return BUNDLED_PET_IDS.some((bundledId) => bundledId === id)
}

/** User-uploaded pet image metadata; renderer fetches bytes from main via pet:read (id, fileName), never learning the on-disk path. */
export type CustomPet = {
  id: string
  label: string
  fileName: string
  /** MIME type for the renderer's Blob Content-Type — esp. image/svg+xml, which browsers won't render from a misdeclared blob URL. */
  mimeType: string
  /** Storage layout: `image` = legacy flat file `custom/<id>.<ext>`; `bundle` = `.codex-pet` expanded into `custom/<id>/`; absent = legacy `image`. */
  kind?: 'image' | 'bundle'
  /** Sprite-sheet metadata; present iff from a `.codex-pet` bundle with a manifest frame layout. Dims derived in main so the renderer needn't probe the image. */
  sprite?: {
    frameWidth: number
    frameHeight: number
    columns: number
    rows: number
    sheetWidth: number
    sheetHeight: number
    fps: number
    defaultAnimation?: string
    animations?: Record<string, SpriteAnimation>
  }
  /** Manifest-declared fps kept even when frames are auto-detected, so playback honors the bundle's speed instead of a hardcoded 8 fps. */
  spriteFps?: number
}

/** One animation strip in a sprite sheet: `row` = 0-based y-index, `frames` = consecutive cells played left-to-right. */
export type SpriteAnimation = {
  row: number
  frames: number
  /** Per-frame holds in ms (length === frames). Absent means uniform sheet fps. */
  frameDurationsMs?: number[]
}

export type PetLibraryEntry = {
  id: string
  /** Custom pets only; built-in names are localized in the renderer. */
  name: string | null
  kind: 'built-in' | 'image' | 'bundle'
  active: boolean
}

/** `pet.list` and `pet.select` result; the other `pet.*` mutations embed it so callers see the outcome. */
export type PetLibrary = {
  activePetId: string
  visible: boolean
  pets: PetLibraryEntry[]
}

export type PetMutationResult = {
  pet: { id: string; name: string; kind: 'image' | 'bundle' }
  library: PetLibrary
}
