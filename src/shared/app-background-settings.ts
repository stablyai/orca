import type { GlobalSettings } from './global-settings-types'

export type AppBackgroundScope = 'window' | 'workspace'

export type AppBackgroundSettings = {
  /** Main-owned `<uuid>.<ext>` under userData/appearance; written only by appBackground:commit. */
  appBackgroundImageId?: string | null
  appBackgroundScope?: AppBackgroundScope
  appBackgroundImageOpacity?: number
  appBackgroundBlur?: number
  /** Chrome surface opacity; only applies while a background image is set. */
  appBackgroundPanelOpacity?: number
}

export const APP_BACKGROUND_SCOPES: readonly AppBackgroundScope[] = ['window', 'workspace']
export const DEFAULT_APP_BACKGROUND_SCOPE: AppBackgroundScope = 'window'

// Why: panels already mask the image; fading it too washes it out on light themes.
export const DEFAULT_APP_BACKGROUND_IMAGE_OPACITY = 1
export const MIN_APP_BACKGROUND_IMAGE_OPACITY = 0
export const MAX_APP_BACKGROUND_IMAGE_OPACITY = 1

// Why: a light blur keeps chrome text readable over busy images at the lower light-theme alpha.
export const DEFAULT_APP_BACKGROUND_BLUR_PX = 4
export const MIN_APP_BACKGROUND_BLUR_PX = 0
export const MAX_APP_BACKGROUND_BLUR_PX = 20

export const DEFAULT_APP_BACKGROUND_PANEL_OPACITY = 0.8
// Why: below this the chrome text loses its backing surface and becomes unreadable on busy images.
export const MIN_APP_BACKGROUND_PANEL_OPACITY = 0.2
export const MAX_APP_BACKGROUND_PANEL_OPACITY = 1

export const APP_BACKGROUND_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export const MAX_APP_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024

const APP_BACKGROUND_IMAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/

/** Image ids are main-generated `<lowercase uuid>.<ext>` file names; the shape doubles as the path-traversal gate. */
export function isAppBackgroundImageId(value: unknown): value is string {
  return typeof value === 'string' && APP_BACKGROUND_IMAGE_ID_RE.test(value)
}

export function normalizeAppBackgroundImageId(value: unknown): string | null {
  return isAppBackgroundImageId(value) ? value : null
}

export function normalizeAppBackgroundScope(value: unknown): AppBackgroundScope {
  return value === 'workspace' || value === 'window' ? value : DEFAULT_APP_BACKGROUND_SCOPE
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

export function normalizeAppBackgroundImageOpacity(value: unknown): number {
  return clampFinite(
    value,
    MIN_APP_BACKGROUND_IMAGE_OPACITY,
    MAX_APP_BACKGROUND_IMAGE_OPACITY,
    DEFAULT_APP_BACKGROUND_IMAGE_OPACITY
  )
}

export function normalizeAppBackgroundBlur(value: unknown): number {
  return clampFinite(
    value,
    MIN_APP_BACKGROUND_BLUR_PX,
    MAX_APP_BACKGROUND_BLUR_PX,
    DEFAULT_APP_BACKGROUND_BLUR_PX
  )
}

export function normalizeAppBackgroundPanelOpacity(value: unknown): number {
  return clampFinite(
    value,
    MIN_APP_BACKGROUND_PANEL_OPACITY,
    MAX_APP_BACKGROUND_PANEL_OPACITY,
    DEFAULT_APP_BACKGROUND_PANEL_OPACITY
  )
}

/** Clamps renderer-written background fields in place; only present keys are touched. */
export function normalizeAppBackgroundSettingsUpdate(update: Partial<GlobalSettings>): void {
  if ('appBackgroundScope' in update) {
    update.appBackgroundScope = normalizeAppBackgroundScope(update.appBackgroundScope)
  }
  if ('appBackgroundImageOpacity' in update) {
    update.appBackgroundImageOpacity = normalizeAppBackgroundImageOpacity(
      update.appBackgroundImageOpacity
    )
  }
  if ('appBackgroundBlur' in update) {
    update.appBackgroundBlur = normalizeAppBackgroundBlur(update.appBackgroundBlur)
  }
  if ('appBackgroundPanelOpacity' in update) {
    update.appBackgroundPanelOpacity = normalizeAppBackgroundPanelOpacity(
      update.appBackgroundPanelOpacity
    )
  }
}

/** Renderer settings writes: drops the main-owned image id and clamps the rest in place. */
export function sanitizeRendererAppBackgroundUpdate(update: Partial<GlobalSettings>): void {
  // Why: the image id names a file main created; only appBackground:commit may point it elsewhere.
  delete update.appBackgroundImageId
  normalizeAppBackgroundSettingsUpdate(update)
}

const APP_BACKGROUND_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp']
])

/** MIME implied by a file extension (with or without the dot), or null when not an allowed image type. */
export function getAppBackgroundImageMimeType(fileNameOrExtension: string): string | null {
  const ext = fileNameOrExtension.slice(fileNameOrExtension.lastIndexOf('.') + 1).toLowerCase()
  return APP_BACKGROUND_MIME_BY_EXTENSION.get(ext) ?? null
}
