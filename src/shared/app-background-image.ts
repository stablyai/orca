export const APP_BACKGROUND_IMAGE_FITS = ['cover', 'contain', 'stretch', 'center'] as const
export type AppBackgroundImageFit = (typeof APP_BACKGROUND_IMAGE_FITS)[number]

export const DEFAULT_APP_BACKGROUND_IMAGE_FIT: AppBackgroundImageFit = 'cover'
export const DEFAULT_APP_BACKGROUND_IMAGE_OPACITY = 0.08
/** Capped because the layer draws over the whole window; full opacity would hide the UI. */
export const MAX_APP_BACKGROUND_IMAGE_OPACITY = 0.35

export const MAX_APP_BACKGROUND_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024
/** Base64 inflates ~4/3 over the 4MB file cap, plus the data: prefix. */
const MAX_APP_BACKGROUND_IMAGE_DATA_URL_LENGTH = 6 * 1024 * 1024

export const APP_BACKGROUND_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const APP_BACKGROUND_IMAGE_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/

/** Undefined (no background) for anything but an inline image data URL within the size cap. */
export function normalizeAppBackgroundImage(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > MAX_APP_BACKGROUND_IMAGE_DATA_URL_LENGTH ||
    !APP_BACKGROUND_IMAGE_DATA_URL_RE.test(value)
  ) {
    return undefined
  }
  return value
}

export function normalizeAppBackgroundImageOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_APP_BACKGROUND_IMAGE_OPACITY
  }
  return Math.min(MAX_APP_BACKGROUND_IMAGE_OPACITY, Math.max(0, value))
}

export function normalizeAppBackgroundImageFit(value: unknown): AppBackgroundImageFit {
  return APP_BACKGROUND_IMAGE_FITS.includes(value as AppBackgroundImageFit)
    ? (value as AppBackgroundImageFit)
    : DEFAULT_APP_BACKGROUND_IMAGE_FIT
}

export type AppBackgroundImageSettingsUpdate = {
  appBackgroundImage?: string
  appBackgroundImageOpacity?: number
  appBackgroundImageFit?: AppBackgroundImageFit
}

/** Sanitizes only the app-background keys present on the update, leaving absent keys absent. */
export function sanitizeAppBackgroundImageSettingsUpdate(args: {
  appBackgroundImage?: unknown
  appBackgroundImageOpacity?: unknown
  appBackgroundImageFit?: unknown
}): AppBackgroundImageSettingsUpdate {
  const update: AppBackgroundImageSettingsUpdate = {}
  if ('appBackgroundImage' in args) {
    update.appBackgroundImage = normalizeAppBackgroundImage(args.appBackgroundImage)
  }
  if ('appBackgroundImageOpacity' in args) {
    update.appBackgroundImageOpacity = normalizeAppBackgroundImageOpacity(
      args.appBackgroundImageOpacity
    )
  }
  if ('appBackgroundImageFit' in args) {
    update.appBackgroundImageFit = normalizeAppBackgroundImageFit(args.appBackgroundImageFit)
  }
  return update
}
