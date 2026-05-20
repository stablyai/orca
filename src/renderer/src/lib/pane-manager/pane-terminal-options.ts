import type { ITerminalOptions } from '@xterm/xterm'

type TerminalCursorStyle = NonNullable<ITerminalOptions['cursorStyle']>
type TerminalCursorInactiveStyle = NonNullable<ITerminalOptions['cursorInactiveStyle']>

export function resolveTerminalCursorInactiveStyle(
  cursorStyle: TerminalCursorStyle | undefined
): TerminalCursorInactiveStyle {
  // Why: xterm's default inactive outline turns a bar/underline cursor into
  // extra strokes in blurred panes; only block cursors benefit from outline.
  return (cursorStyle ?? 'bar') === 'block' ? 'outline' : (cursorStyle ?? 'bar')
}

export function buildDefaultTerminalOptions(): ITerminalOptions {
  const cursorStyle: TerminalCursorStyle = 'bar'

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
    scrollback: 10000,
    allowTransparency: false,
    // Why: on macOS, non-US layouts rely on Option to compose characters like @ and €.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    // Why: advertise kitty keyboard protocol support so CLIs that probe
    // (CSI ? u) know Orca accepts enhanced key reporting. Orca still writes
    // CSI-u for Shift+Enter on non-Windows platforms; programs that respect
    // the handshake otherwise fall back to legacy encodings and miss it.
    // Matches VS Code's xtermTerminal.ts.
    vtExtensions: {
      kittyKeyboard: true
    }
  }
}
