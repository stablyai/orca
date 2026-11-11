import { CLAUDE_IDLE } from '../agent-title-glyphs'

// jcode updates emoji/session/diff/duration titles about once a second (terminal_title.rs); generated codenames are identity, not conversation names.
// Captured provenance: docs/reference/jcode-hook-events.md.
const JCODE_TITLE_STATUS_RE =
  /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*|\s+·\s+(?:\+\d+\s+-\d+|(?:work|last)\s+~\S+|working)(?=\s+·\s+|$)/gu

/** The jcode title with its per-session emoji and live diff/duration segments removed. */
export function stripJcodeTitleStatus(title: string): string {
  return title.replace(JCODE_TITLE_STATUS_RE, '').trim()
}

// jcode, jcode Puppy and self-dev jcode/creek Puppy are identity; user work labels contain more.
const JCODE_IDENTITY_TITLE_RE = /^jcode(?:\/[^\s·]+)?(?:\s+[^\s·]+)?$/iu

/** True when a jcode title says only which jcode session this is, not what it is doing. */
export function isJcodeIdentityTerminalTitle(title: string | null | undefined): boolean {
  // Claude's ✳ is also an emoji; `✳ Jcode hooks` is a Claude task title.
  return (
    Boolean(title) &&
    !title?.trimStart().startsWith(CLAUDE_IDLE) &&
    JCODE_IDENTITY_TITLE_RE.test(stripJcodeTitleStatus(title ?? ''))
  )
}

// title_with_metrics: `<emoji> <label> · work ~2m05s` (or `· working`) mid-turn, `· last ~2m05s` after it.
const JCODE_SESSION_TITLE_RE =
  /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s.*\s·\s(?:(work|last)\s~(?:\d+h\d{2}m|\d+m\d{2}s|\d+s)|working)$/u

/** Activity from jcode's own title; conversation-titled sessions carry only the tail, so identity comes from the process. */
export function jcodeTitleStatus(title: string): 'working' | 'idle' | null {
  const tail = title.trimStart().startsWith(CLAUDE_IDLE) ? null : JCODE_SESSION_TITLE_RE.exec(title)
  if (tail) {
    return tail[1] === 'last' ? 'idle' : 'working'
  }
  return isJcodeIdentityTerminalTitle(title) ? 'idle' : null
}
