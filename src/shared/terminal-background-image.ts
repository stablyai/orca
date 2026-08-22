import { validateRasterImageDataUri } from './image-data-uri'

export type TerminalBackgroundImageFit = 'cover' | 'contain' | 'stretch' | 'center'

export const TERMINAL_BACKGROUND_IMAGE_FITS: readonly TerminalBackgroundImageFit[] = [
  'cover',
  'contain',
  'stretch',
  'center'
]

export const DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY = 0.15
export const DEFAULT_TERMINAL_BACKGROUND_IMAGE_FIT: TerminalBackgroundImageFit = 'cover'

// Why inline data URL: the renderer cannot load arbitrary file:// paths (webSecurity + repo-scoped fs auth),
// and the settings file already carries repo icons the same way.
export const MAX_TERMINAL_BACKGROUND_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_TERMINAL_BACKGROUND_IMAGE_DATA_URL_LENGTH = 6 * 1024 * 1024

export const TERMINAL_BACKGROUND_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export function normalizeTerminalBackgroundImage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TERMINAL_BACKGROUND_IMAGE_DATA_URL_LENGTH) {
    return undefined
  }
  if (!/^data:image\//i.test(trimmed)) {
    return undefined
  }
  return validateRasterImageDataUri(trimmed) ?? undefined
}

export function normalizeTerminalBackgroundImageOpacity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(1, Math.max(0, value))
}

export function normalizeTerminalBackgroundImageFit(
  value: unknown
): TerminalBackgroundImageFit | undefined {
  return TERMINAL_BACKGROUND_IMAGE_FITS.includes(value as TerminalBackgroundImageFit)
    ? (value as TerminalBackgroundImageFit)
    : undefined
}

export type TerminalBackgroundImageSettings = {
  terminalBackgroundImage?: string
  terminalBackgroundImageOpacity?: number
  terminalBackgroundImageFit?: TerminalBackgroundImageFit
}

/** Copies only the background-image keys present in `updates` onto `target`, sanitized. */
export function sanitizeTerminalBackgroundImageSettings(
  updates: TerminalBackgroundImageSettings,
  target: TerminalBackgroundImageSettings
): void {
  if ('terminalBackgroundImage' in updates) {
    target.terminalBackgroundImage = normalizeTerminalBackgroundImage(
      updates.terminalBackgroundImage
    )
  }
  if ('terminalBackgroundImageOpacity' in updates) {
    target.terminalBackgroundImageOpacity = normalizeTerminalBackgroundImageOpacity(
      updates.terminalBackgroundImageOpacity
    )
  }
  if ('terminalBackgroundImageFit' in updates) {
    target.terminalBackgroundImageFit = normalizeTerminalBackgroundImageFit(
      updates.terminalBackgroundImageFit
    )
  }
}

export type TerminalBackgroundImageCss = {
  size: string
  position: string
  repeat: string
}

export function resolveTerminalBackgroundImageCss(
  fit: TerminalBackgroundImageFit | undefined
): TerminalBackgroundImageCss {
  switch (fit ?? DEFAULT_TERMINAL_BACKGROUND_IMAGE_FIT) {
    case 'contain':
      return { size: 'contain', position: 'center', repeat: 'no-repeat' }
    case 'stretch':
      return { size: '100% 100%', position: 'center', repeat: 'no-repeat' }
    case 'center':
      return { size: 'auto', position: 'center', repeat: 'no-repeat' }
    case 'cover':
    default:
      return { size: 'cover', position: 'center', repeat: 'no-repeat' }
  }
}
