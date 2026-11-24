export const MIN_FLOATING_PANEL_OPACITY = 0.3
export const DEFAULT_FLOATING_PANEL_OPACITY = 1

export type FloatingPanelOpacitySettings = {
  floatingTerminalPanelOpacity: number
}

export function resolveFloatingPanelOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(DEFAULT_FLOATING_PANEL_OPACITY, Math.max(MIN_FLOATING_PANEL_OPACITY, value))
    : DEFAULT_FLOATING_PANEL_OPACITY
}
