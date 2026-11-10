import type { GlobalSettings } from '../../../shared/global-settings-types'

export const FILE_EXPLORER_FONT_SIZE_MIN = 10
export const FILE_EXPLORER_FONT_SIZE_MAX = 20
/** The `text-xs` size rows had before the setting existed. */
export const FILE_EXPLORER_DEFAULT_FONT_SIZE = 12
/** The virtualizer estimate rows had before the setting existed. */
const DEFAULT_ROW_HEIGHT = 26

export function resolveFileExplorerFontSize(
  settings: Pick<GlobalSettings, 'fileExplorerFontSize'> | null | undefined
): number {
  const size = settings?.fileExplorerFontSize
  if (typeof size !== 'number' || !Number.isFinite(size)) {
    return FILE_EXPLORER_DEFAULT_FONT_SIZE
  }
  return Math.min(
    FILE_EXPLORER_FONT_SIZE_MAX,
    Math.max(FILE_EXPLORER_FONT_SIZE_MIN, Math.round(size))
  )
}

/** Rows are measured once rendered; this only sizes the ones not rendered yet. */
export function estimateFileExplorerRowHeight(fontSize: number): number {
  // Why: only the text-xs line box (4/3 of the font) grows; the 8px row padding does not.
  return DEFAULT_ROW_HEIGHT + Math.round(((fontSize - FILE_EXPLORER_DEFAULT_FONT_SIZE) * 4) / 3)
}
