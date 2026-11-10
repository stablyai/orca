/** Default matches Tailwind `text-xs` used by File Explorer rows. */
export const DEFAULT_FILE_EXPLORER_FONT_SIZE = 12
export const MIN_FILE_EXPLORER_FONT_SIZE = 10
export const MAX_FILE_EXPLORER_FONT_SIZE = 20

export function clampFileExplorerFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FILE_EXPLORER_FONT_SIZE
  }
  return Math.min(
    MAX_FILE_EXPLORER_FONT_SIZE,
    Math.max(MIN_FILE_EXPLORER_FONT_SIZE, Math.round(value))
  )
}

/** Virtual row height scales with font so larger type does not clip. */
export function fileExplorerRowHeightPx(fontSize: number): number {
  const size = clampFileExplorerFontSize(fontSize)
  // Why: 12px type used 26px rows; keep ~14px vertical chrome around the glyph.
  return size + 14
}
