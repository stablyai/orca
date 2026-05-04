import type { ITerminalOptions } from '@xterm/xterm'

export function buildDefaultTerminalOptions(): ITerminalOptions {
  return {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
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
    // (CSI ? u) know Orca accepts enhanced key reporting. Without this,
    // Orca already writes \x1b[13;2u for Shift+Enter (see
    // terminal-shortcut-policy.ts), but programs that respect the protocol
    // handshake fall back to legacy encodings and ignore the CSI-u byte,
    // making chords like Shift+Enter invisible to the app — especially
    // noticeable inside tmux. Matches VS Code's xtermTerminal.ts.
    vtExtensions: {
      kittyKeyboard: true
    }
  }
}
