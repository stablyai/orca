import type { ITerminalOptions } from '@xterm/xterm'

type TerminalCursorStyle = NonNullable<ITerminalOptions['cursorStyle']>
type TerminalCursorInactiveStyle = NonNullable<ITerminalOptions['cursorInactiveStyle']>

export function resolveTerminalCursorInactiveStyle(
  cursorStyle: TerminalCursorStyle | undefined
): TerminalCursorInactiveStyle {
  // Why: xterm's default inactive outline turns a bar/underline cursor into
  // extra strokes in blurred panes; only block cursors benefit from outline.
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
    scrollback: 10000,
    allowTransparency: false,
    // Why: agent CLIs sometimes render body text with ANSI white/bright-white
    // on light themes; xterm can keep those cells readable across renderers.
    minimumContrastRatio: 4.5,
    // Why: on macOS, non-US layouts rely on Option to compose characters like @ and €.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    scrollbar: {
      // Why: slim VS Code-style scrollbar (VS Code uses 14). FitAddon reserves
      // this as a gutter, costing ~1 column per pane — accepted tradeoff so the
      // scrollbar never covers content (evidence in PR #5051). The v1.4.51
      // table corruption #4877 fixed by zeroing this was actually the ZWJ
      // width bug; it stays fixed by pane-terminal-unicode-provider.ts. Width
      // also enables the overview ruler, whose border is hidden in
      // composeActiveTerminalTheme.
      width: 7
    },
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
