/**
 * Builds the exact bytes Orca writes into an interactive shell to deliver and
 * submit a startup command (agent launch, setup script, etc.).
 *
 * Why bracketed paste: agent launch prompts are single-quoted, but their
 * literal embedded newlines survive quoting. bash readline / zsh zle bind a raw
 * LF to accept-line by default, so the first newline inside a multiline prompt
 * submits an unterminated single-quoted command and drops the shell into PS2
 * continuation — the prompt is executed piecemeal and mangled. Wrapping the
 * payload in bracketed-paste markers (ESC[200~ … ESC[201~) tells the line
 * editor to insert the whole multiline text literally; only the submit byte
 * written after the end marker submits it. Single-line commands keep the proven
 * raw-write path unchanged so the fast path never regresses.
 */

// DEC 2004 bracketed-paste bracket sequences.
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * The byte Orca writes to submit a startup command, on every platform.
 *
 * Why CR rather than a per-platform CR/LF choice: while a line editor is reading
 * a line it puts the terminal in raw mode, so the kernel's ICRNL translation is
 * off and LF arrives as its own key, `^J`, subject to the user's keymap — zsh's
 * `bindkey -M viins '^J' …` or bash readline's `"\C-j"` binding. Enter itself
 * sends CR, so CR is what a shell must be handed to run the line. Measured on
 * macOS in real ptys: with `^J` bound to insert-a-newline, LF left `echo` at the
 * prompt while CR ran it, in both zsh and bash; with default bindings both bytes
 * ran it, which is why a LF-only choice passes CI and fails on a configured
 * shell. Windows (PSReadLine, cmd.exe) already needs CR, so one byte covers all
 * three platforms instead of guessing per host.
 */
export const STARTUP_COMMAND_SUBMIT_BYTE = '\r'

export type StartupCommandSubmissionOptions = {
  /** Byte that submits the line, defaulting to {@link STARTUP_COMMAND_SUBMIT_BYTE}
   *  — the daemon, local-provider and relay paths all take the default. The SSH
   *  automation path names it to record that a remote shell is driven there. A
   *  caller-supplied trailing submit byte on `command` is preserved as-is. */
  submit?: string
  /** Whether the target line editor has bracketed-paste mode active (Orca's
   *  wrapped bash/zsh/fish). Only wrap multiline payloads when true — a shell
   *  without bracketed paste would echo the ESC[200~ markers as literal garbage. */
  bracketedPasteSafe: boolean
}

/**
 * Whether a spawned POSIX shell will read a bracketed-paste payload as one
 * multiline command.
 *
 * Why fish needs the ready barrier: bash readline and zsh zle interpret the
 * ESC[200~ wrapper out of their buffered input, but fish consumes bytes during
 * its startup terminal-query handshake, so a payload written before its reader
 * is up lands as literal `200~` text and the command never runs (verified
 * against fish 4.7). Waiting for the shell-ready barrier is what makes fish
 * paste-safe, and it is what the daemon and relay backends already require.
 */
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
  { submit = STARTUP_COMMAND_SUBMIT_BYTE, bracketedPasteSafe }: StartupCommandSubmissionOptions
): string {
  // Strip a full CRLF (or lone CR/LF) terminator so a single-line command ending
  // in \r\n isn't misread as multiline by the \r/\n body check below.
  const trailingTerminator = /\r\n$|\r$|\n$/.exec(command)?.[0] ?? ''
  const endsWithSubmit = trailingTerminator.length > 0
  const body = endsWithSubmit ? command.slice(0, -trailingTerminator.length) : command
  if (bracketedPasteSafe && (body.includes('\n') || body.includes('\r'))) {
    return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}${submit}`
  }
  return endsWithSubmit ? command : `${command}${submit}`
}
