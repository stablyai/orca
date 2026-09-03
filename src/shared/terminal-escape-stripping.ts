// Canonical terminal-escape stripper for turning raw PTY output into plain,
// greppable text. The most thorough stripper in the codebase (CSI + OSC with
// BEL/ST terminators + CR normalization + residual control sweep); narrower
// one-off strippers elsewhere should migrate here over time.

// CSI (colors/cursor), OSC (titles/hyperlinks), and stray escapes.
const CSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]/g
const OSC_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
// Remaining two-byte Fe escapes; any stray lone ESC falls into the final
// control-char sweep below.
const OTHER_ESC_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b[@-Z\\-_]/g
// Everything below 0x20 except backslash-n and backslash-t, plus DEL.
const RESIDUAL_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function stripTerminalSequences(data: string): string {
  return (
    data
      .replace(OSC_RE, '')
      .replace(CSI_RE, '')
      .replace(OTHER_ESC_RE, '')
      // Progress spinners rewrite lines with bare CR; in a file each rewrite
      // becomes its own line so the final state is still readable.
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(RESIDUAL_CONTROL_RE, '')
  )
}
