/** auto keeps Orca's split: terminals hold a fixed width, file/browser tabs fit their titles. */
export type TabSizingMode = 'auto' | 'fit' | 'shrink' | 'fixed'

export const TAB_SIZING_MODES: readonly TabSizingMode[] = ['auto', 'fit', 'shrink', 'fixed']
export const DEFAULT_TAB_MIN_WIDTH = 144
export const DEFAULT_TAB_MAX_WIDTH = 300
export const TAB_WIDTH_LOWER_BOUND = 60
export const TAB_WIDTH_UPPER_BOUND = 800

/** Mirrors VS Code's workbench.editor.tabSizing; optional so older profiles read as auto 144–300px. */
export type TabSizingSettings = {
  tabSizing?: TabSizingMode
  tabSizingMinWidth?: number
  tabSizingMaxWidth?: number
}

export type TabSizing = {
  mode: TabSizingMode
  minWidth: number
  maxWidth: number
}

function clampWidth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.round(Math.min(TAB_WIDTH_UPPER_BOUND, Math.max(TAB_WIDTH_LOWER_BOUND, value)))
}

function isTabSizingMode(value: unknown): value is TabSizingMode {
  return TAB_SIZING_MODES.some((mode) => mode === value)
}

export function normalizeTabSizingMode(value: unknown): TabSizingMode {
  return isTabSizingMode(value) ? value : 'auto'
}

// Settings sync from older/newer peers, so tolerate missing or out-of-range values and keep max >= min.
export function normalizeTabSizing(
  settings:
    | { tabSizing?: unknown; tabSizingMinWidth?: unknown; tabSizingMaxWidth?: unknown }
    | null
    | undefined
): TabSizing {
  const minWidth = clampWidth(settings?.tabSizingMinWidth, DEFAULT_TAB_MIN_WIDTH)
  const maxWidth = Math.max(
    minWidth,
    clampWidth(settings?.tabSizingMaxWidth, DEFAULT_TAB_MAX_WIDTH)
  )
  return { mode: normalizeTabSizingMode(settings?.tabSizing), minWidth, maxWidth }
}
