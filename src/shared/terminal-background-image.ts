export type TerminalBackgroundImage = {
  /** UUID, always generated in main (never sourced from the renderer). */
  id: string
  /** On-disk name inside the storage dir: `${id}${ext}`. Written only by main. */
  fileName: string
  mimeType: string
  /** Original basename of the picked file, display only. */
  label?: string
}

// Why: single source of truth for what the renderer will try to display as a
// pane background. Raster formats only — the image is painted with CSS
// background-size: cover, where SVG's lack of intrinsic pixel size makes
// scaling behavior inconsistent across themes.
export const TERMINAL_BACKGROUND_IMAGE_FORMATS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_BACKGROUND_IMAGE_LABEL_LENGTH = 80

/** Canonical storage-id gate: ids are UUIDs minted only in main, so this is the
 *  single check every fs path that embeds an id must pass. Shared so the main
 *  handler and the settings normalizer cannot drift on what a valid id is. */
export function isBackgroundImageStorageId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** The allowlisted MIME for `${id}` + extension, or null. Rejects any fileName
 *  that isn't `${id}.<allowed-ext>` (which also rules out path separators and
 *  traversal). Shared by the normalizer and the main read/delete path resolver
 *  so the extension allowlist is enforced identically on both sides. */
export function backgroundImageFileMime(id: string, fileName: unknown): string | null {
  if (!isBackgroundImageStorageId(id) || typeof fileName !== 'string') {
    return null
  }
  if (!fileName.startsWith(`${id}.`)) {
    return null
  }
  const ext = fileName.slice(id.length).toLowerCase()
  return TERMINAL_BACKGROUND_IMAGE_FORMATS[ext] ?? null
}

/** Clamp a display label to the shared max length, or undefined when it is
 *  empty or extension-only (e.g. a file literally named `.png`). */
export function normalizeBackgroundImageLabel(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || trimmed.startsWith('.')) {
    return undefined
  }
  return trimmed.slice(0, MAX_BACKGROUND_IMAGE_LABEL_LENGTH)
}

/** Normalize a persisted or IPC-supplied background image reference.
 *
 *  Returns null unless the reference could only have been minted by main:
 *  UUID id, fileName exactly `${id}` + an allowlisted extension (which also
 *  rules out path separators and traversal), and the matching MIME type.
 *  Applied at every settings boundary, like normalizeTerminalCustomThemes. */
export function normalizeTerminalBackgroundImage(value: unknown): TerminalBackgroundImage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id : ''
  const fileName = typeof input.fileName === 'string' ? input.fileName : ''
  const mimeType = backgroundImageFileMime(id, fileName)
  if (!mimeType || input.mimeType !== mimeType) {
    return null
  }
  const label = normalizeBackgroundImageLabel(input.label)
  return {
    id,
    fileName,
    mimeType,
    ...(label ? { label } : {})
  }
}
