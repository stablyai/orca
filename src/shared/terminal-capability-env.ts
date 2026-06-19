const XTERM_JS_COMPATIBLE_TERM_PROGRAM = 'vscode'
const XTERM_JS_COMPATIBLE_TERM_PROGRAM_VERSION = '1.100.0'

export function buildTerminalCapabilityEnv(appVersion: string): Record<string, string> {
  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // Why: Claude Code and other CLIs gate OSC 8 links on known xterm.js
    // embedders. Do not change this back to "Orca": that makes PR links
    // render as plain text. ORCA_* keeps our real app identity available.
    TERM_PROGRAM: XTERM_JS_COMPATIBLE_TERM_PROGRAM,
    TERM_PROGRAM_VERSION: XTERM_JS_COMPATIBLE_TERM_PROGRAM_VERSION,
    ORCA_TERM_PROGRAM: 'Orca',
    ORCA_TERM_PROGRAM_VERSION: appVersion,
    // Why: supports-hyperlinks can still miss Electron embedders; force OSC 8
    // output because Orca parses and routes those links natively.
    FORCE_HYPERLINK: '1'
  }
}
