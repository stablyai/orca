export type TabWidthMode = 'default' | 'fit'

export type TabWidthGlobalSettings = {
  /** 'default' keeps Orca's adaptive strip; 'fit' sizes every tab to its title and scrolls horizontally on overflow. */
  tabWidthMode?: TabWidthMode
  /** Maximum tab width in CSS pixels; caps both default and fit tabs as well as the inline rename slot. */
  tabMaxWidth?: number
}

export const TAB_MAX_WIDTH_DEFAULT_PX = 300
export const TAB_MAX_WIDTH_MIN_PX = 140
export const TAB_MAX_WIDTH_MAX_PX = 480

export function normalizeTabWidthMode(value: unknown): TabWidthMode {
  return value === 'fit' ? 'fit' : 'default'
}

export function normalizeTabMaxWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TAB_MAX_WIDTH_DEFAULT_PX
  }
  return Math.min(TAB_MAX_WIDTH_MAX_PX, Math.max(TAB_MAX_WIDTH_MIN_PX, Math.round(value)))
}
