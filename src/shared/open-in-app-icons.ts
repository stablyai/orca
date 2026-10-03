import { validateRasterImageDataUri } from './image-data-uri'

/**
 * Bundled icon choices for "Open in" apps. Ids are lucide component names so the
 * renderer can map them without a translation table; anything outside this list is
 * rejected, which keeps the setting safe to sync to clients that render it.
 */
export const OPEN_IN_APP_ICON_IDS = [
  'AppWindow',
  'Code2',
  'SquareTerminal',
  'FileCode',
  'Braces',
  'Pencil',
  'PanelsTopLeft',
  'Bot',
  'Sparkles',
  'Database',
  'Globe',
  'FolderOpen',
  'Rocket',
  'Wrench',
  'Palette',
  'Box'
] as const

export type OpenInAppIconId = (typeof OPEN_IN_APP_ICON_IDS)[number]

/** A bundled glyph, or the real icon extracted from an application the user picked. */
export type OpenInAppIcon =
  | { type: 'bundled'; id: OpenInAppIconId }
  | { type: 'image'; src: string }

// Why: a picked icon rides inside global settings, which sync to every paired
// client — a 64px PNG lands well under this, so anything larger is a hand-edited
// or corrupted entry rather than something we should relay.
export const MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH = 64 * 1024

// Why: we generate the image ourselves via nativeImage.toDataURL(), so the accepted
// shape can stay exact — no SVG (scriptable) and no remote URLs (they would make
// menu rendering depend on the network).
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

function isOpenInAppIconId(value: unknown): value is OpenInAppIconId {
  return typeof value === 'string' && (OPEN_IN_APP_ICON_IDS as readonly string[]).includes(value)
}

export function isOpenInAppIconImageSrc(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    return false
  }
  if (value.length > MAX_OPEN_IN_APP_ICON_DATA_URL_LENGTH) {
    return false
  }
  const payload = value.slice(PNG_DATA_URL_PREFIX.length)
  if (payload.length === 0 || !BASE64_PATTERN.test(payload)) {
    return false
  }
  // Why: the byte cap bounds the payload, not the dimensions the PNG header declares.
  // Same decode-bomb guard the repo-icon upload path applies.
  return validateRasterImageDataUri(value) !== null
}

export function normalizeOpenInAppIcon(value: unknown): OpenInAppIcon | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as { type?: unknown; id?: unknown; src?: unknown }
  if (candidate.type === 'bundled' && isOpenInAppIconId(candidate.id)) {
    return { type: 'bundled', id: candidate.id }
  }
  if (candidate.type === 'image' && isOpenInAppIconImageSrc(candidate.src)) {
    return { type: 'image', src: candidate.src }
  }
  return null
}
