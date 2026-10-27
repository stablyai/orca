/** Bracketed paste preserves embedded prompt newlines; raw LF can submit an unfinished quote into PS2.
 * Wrap only multiline input to paste-enabled readers, then submit with CR; single-line input keeps the raw path. */

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
// Enter sends CR; raw-mode LF is Ctrl+J, which users may rebind.
const STARTUP_COMMAND_SUBMIT = '\r'

export type StartupCommandSubmissionOptions = {
  /** Only wrap for paste-enabled readers; unsupported shells display the escape markers literally. */
  bracketedPasteSafe: boolean
}

/** Fish needs the ready barrier: startup terminal queries consume early paste bytes as literal text (verified fish 4.7).
 * Bash/zsh readers handle buffered paste; daemon/relay hosts already wait for fish readiness. */
export function isBracketedPasteSafeShell(args: {
  shellName: string
  waitsForShellReady: boolean
}): boolean {
  const name = args.shellName.toLowerCase()
  if (name === 'bash' || name === 'zsh') {
    return true
  }
  return name === 'fish' && args.waitsForShellReady
}

export function buildStartupCommandSubmission(
  command: string,
  { bracketedPasteSafe }: StartupCommandSubmissionOptions
): string {
  // Replace the terminator: LF is Ctrl+J and CRLF would submit twice.
  const body = command.replace(/\r\n$|\r$|\n$/, '')
  if (bracketedPasteSafe && (body.includes('\n') || body.includes('\r'))) {
    return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}${STARTUP_COMMAND_SUBMIT}`
  }
  // Without bracketed paste each interior newline submits; use CR instead of remappable Ctrl+J.
  return `${body.replace(/\r?\n/g, STARTUP_COMMAND_SUBMIT)}${STARTUP_COMMAND_SUBMIT}`
}
