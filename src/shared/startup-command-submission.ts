/**
 * Builds the exact bytes Orca writes into an interactive shell to deliver and
 * submit a startup command (agent launch, setup script, etc.).
 *
 * Why bracketed paste: agent launch prompts are single-quoted, but their
 * literal embedded newlines survive quoting. bash readline / zsh zle read a raw
 * LF as accept-line by default, so the first newline inside a multiline prompt
 * submits an unterminated single-quoted command and drops the shell into PS2
 * continuation — the prompt is executed piecemeal and mangled. Wrapping the
 * payload in bracketed-paste markers (ESC[200~ … ESC[201~) tells the line
 * editor to insert the whole multiline text literally; only the trailing CR
 * written after the end marker submits it. Single-line commands keep the proven
 * raw-write path unchanged so the fast path never regresses.
 */

// DEC 2004 bracketed-paste bracket sequences.
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
// Why CR on every platform: it is the byte the Enter key sends. A line editor reads
// the tty raw, so LF arrives as Ctrl+J — a key users rebind (e.g. vi-mode newline).
const STARTUP_COMMAND_SUBMIT = '\r'

export type StartupCommandSubmissionOptions = {
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
  { bracketedPasteSafe }: StartupCommandSubmissionOptions
): string {
  // Why replace a caller's terminator: a trailing LF is Ctrl+J again, and CRLF submits twice.
  const body = command.replace(/\r\n$|\r$|\n$/, '')
  if (bracketedPasteSafe && (body.includes('\n') || body.includes('\r'))) {
    return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}${STARTUP_COMMAND_SUBMIT}`
  }
  // Why normalise interior breaks too: without bracketed paste each line submits itself, and an
  // interior LF is the same remappable Ctrl+J as a trailing one.
  return `${body.replace(/\r?\n/g, STARTUP_COMMAND_SUBMIT)}${STARTUP_COMMAND_SUBMIT}`
}
