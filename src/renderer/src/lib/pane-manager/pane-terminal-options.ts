import type { ITerminalOptions } from '@xterm/xterm'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../shared/terminal-scrollback-policy'
import { LIGHT_BG_MIN_CONTRAST } from '@/lib/terminal-contrast-correction'

type TerminalCursorStyle = NonNullable<ITerminalOptions['cursorStyle']>
type TerminalCursorInactiveStyle = NonNullable<ITerminalOptions['cursorInactiveStyle']>

export const DEFAULT_TERMINAL_SCROLL_SENSITIVITY = 1.15
export const DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY = 5

export function normalizeTerminalScrollSensitivity(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(10, Math.max(0.1, value))
    : DEFAULT_TERMINAL_SCROLL_SENSITIVITY
}

export function normalizeTerminalFastScrollSensitivity(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(20, Math.max(1, value))
    : DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY
}

export function resolveTerminalCursorInactiveStyle(
  cursorStyle: TerminalCursorStyle | undefined
): TerminalCursorInactiveStyle {
  // Inactive outline adds unwanted strokes to bar/underline cursors; reserve it for block cursors.
  return (cursorStyle ?? 'block') === 'block' ? 'outline' : (cursorStyle ?? 'block')
}

export function buildDefaultTerminalOptions(): ITerminalOptions {
  const cursorStyle: TerminalCursorStyle = 'block'

  return {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle,
    cursorInactiveStyle: resolveTerminalCursorInactiveStyle(cursorStyle),
    fontSize: 14,
    // Cross-platform fallback chain; keep in sync with FALLBACK_FONTS in layout-serialization.ts.
    fontFamily:
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
    fontWeight: '300',
    fontWeightBold: '500',
    scrollback: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    // A small wheel multiplier offsets Orca’s taller default terminal cells.
    scrollSensitivity: DEFAULT_TERMINAL_SCROLL_SENSITIVITY,
    fastScrollSensitivity: DEFAULT_TERMINAL_FAST_SCROLL_SENSITIVITY,
    allowTransparency: false,
    // Initial value only; applyTerminalAppearance re-gates by background luminance (#7934) before any content paints.
    minimumContrastRatio: LIGHT_BG_MIN_CONTRAST,
    // Why: on macOS, non-US layouts rely on Option to compose characters like @ and €.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    scrollbar: {
      // Accept the slim scrollbar’s ~one-column gutter cost and enable overview ruler. The old v1.4.51 table corruption was the ZWJ width bug, now fixed by terminal-unicode-provider; composeActiveTerminalTheme hides the ruler border.
      width: 7
    },
    // Advertise KKP so handshake-gated CLIs accept Orca’s enhanced CSI-u chords (including Shift+Enter off Windows), matching VS Code.
    vtExtensions: {
      kittyKeyboard: true
    }
  }
}
