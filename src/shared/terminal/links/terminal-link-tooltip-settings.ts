// Centralize null handling like terminal-inline-images-settings.ts: the stored value can be
// undefined before first hydration, and null once existed as a persisted shape.
export function resolveTerminalLinkTooltipEnabled(value: boolean | null | undefined): boolean {
  return value !== false
}

export type TerminalLinkTooltipSettings = {
  /** Show the bottom link-target preview bar while hovering detected links; links stay clickable when off. */
  terminalLinkTooltipEnabled?: boolean
}
