export const PET_SIZE_MIN = 60
export const PET_SIZE_MAX = 360
export const PET_SIZE_DEFAULT = 180

export function clampPetSize(size: number | undefined): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return PET_SIZE_DEFAULT
  }
  return Math.max(PET_SIZE_MIN, Math.min(PET_SIZE_MAX, Math.round(size)))
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

/** Pet animation driven purely by agent state. The detached pet window renders in its own
 *  BrowserWindow with no access to the agent store, so the main window publishes this slice
 *  and the pet window layers its local drag/hover states on top. */
export type PetAgentAnimation = 'idle' | 'running' | 'waiting' | 'review'

const PET_AGENT_ANIMATIONS: readonly PetAgentAnimation[] = ['idle', 'running', 'waiting', 'review']

export function isPetAgentAnimation(value: unknown): value is PetAgentAnimation {
  return typeof value === 'string' && PET_AGENT_ANIMATIONS.includes(value as PetAgentAnimation)
}

/** Top-left of the detached pet window in screen (DIP) coordinates. */
export type PetWindowPosition = { x: number; y: number }

export function isPetWindowPosition(value: unknown): value is PetWindowPosition {
  if (!value || typeof value !== 'object') {
    return false
  }
  const { x, y } = value as { x?: unknown; y?: unknown }
  return Number.isFinite(x) && Number.isFinite(y)
}
