/**
 * Builds the exact bytes Orca writes into an interactive shell to deliver and
 * submit a startup command (agent launch, setup script, etc.).
 *
 * Why bracketed paste: agent launch prompts are single-quoted, but their
 * literal embedded newlines survive quoting. bash readline / zsh zle read every
 * raw LF as accept-line (Enter), so the first newline inside a multiline prompt
 * submits an unterminated single-quoted command and drops the shell into PS2
 * continuation — the prompt is executed piecemeal and mangled. Wrapping the
 * payload in bracketed-paste markers (ESC[200~ … ESC[201~) tells the line
 * editor to insert the whole multiline text literally; only the trailing CR/LF
 * written after the end marker submits it. Single-line commands keep the proven
 * raw-write path unchanged so the fast path never regresses.
 */

// DEC 2004 bracketed-paste bracket sequences.
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

export type StartupCommandSubmissionOptions = {
  /** Byte that submits the line: CR on Windows (PSReadLine/cmd.exe), LF on
   *  POSIX; SSH relays remote shells with CR. A caller-supplied trailing submit
   *  byte on `command` is preserved as-is. */
  submit: string
  /** Whether the target line editor has bracketed-paste mode active (Orca's
   *  wrapped bash/zsh). Only wrap multiline payloads when true — a shell without
   *  bracketed paste would echo the ESC[200~ markers as literal garbage. */
  bracketedPasteSafe: boolean
}

export function buildStartupCommandSubmission(
  command: string,
  { submit, bracketedPasteSafe }: StartupCommandSubmissionOptions
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
