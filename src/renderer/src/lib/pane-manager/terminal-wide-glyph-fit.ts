// Orca's xterm patch (config/patches/xterm-src) adds this option; the published typings lack it.
declare module '@xterm/xterm' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- augmentation must merge into xterm's interface
  interface ITerminalOptions {
    /** Enlarge Hangul, Han and Kana fallback glyphs toward their two cells and center wide glyphs. */
    fitWideGlyphs?: boolean
  }
}

// Why on: CJK fallback faces advance ~1.4 cells, so unfitted text reads as if double-spaced.
export const DEFAULT_TERMINAL_FIT_WIDE_GLYPHS = true

export function resolveTerminalFitWideGlyphs(setting: boolean | null | undefined): boolean {
  return typeof setting === 'boolean' ? setting : DEFAULT_TERMINAL_FIT_WIDE_GLYPHS
}
