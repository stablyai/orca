// A respawned terminal's saved tail can carry the previous boot's last prompt with the new shell's
// prompt printed right after it on the same row ("…/w2slot$ ubuntu@w2slot:~/…"), above rows that
// were never written. The read-only copy shows each prompt on its own line and starts at the first
// line with output, so it reads like the terminal did.

/** A shell prompt ending ("$" or "#", maybe a space) directly followed by another "user@host:". */
const GLUED_PROMPT = /(?<=[$#] ?)(?=[\w.-]+@[\w.-]+:)/

export function tidyTerminalTail(lines: readonly string[]): string[] {
  const split = lines.flatMap((line) => line.split(GLUED_PROMPT).map((part) => part.trimEnd()))
  let start = 0
  while (start < split.length && split[start] === '') {
    start++
  }
  let end = split.length
  while (end > start && split[end - 1] === '') {
    end--
  }
  return split.slice(start, end)
}
