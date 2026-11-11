import { CLAUDE_IDLE } from '../agent-title-glyphs'

// jcode updates emoji/session/diff/duration titles about once a second (terminal_title.rs); generated codenames are identity, not conversation names.
// Captured provenance: docs/reference/jcode-hook-events.md.
// (?<!\s) starts each separator at its whitespace run so long space runs stay linear.
const JCODE_TITLE_STATUS_RE =
  /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*|(?<!\s)\s+·\s+(?:\+\d+\s+-\d+|(?:work|last)\s+~\S+|working)(?=\s+·\s+|$)/gu

/** The jcode title with its per-session emoji and live diff/duration segments removed. */
export function stripJcodeTitleStatus(title: string): string {
  return title.replace(JCODE_TITLE_STATUS_RE, '').trim()
}

// jcode, jcode Puppy and jcode/marsh Puppy (server name) are identity; user work labels contain more.
const JCODE_IDENTITY_TITLE_RE = /^jcode(?:\/[\w-]+)?(?:\s+[^\s·]+)?$/iu

/** True when a jcode title says only which jcode session this is, not what it is doing. */
export function isJcodeIdentityTerminalTitle(title: string | null | undefined): boolean {
  // Claude's ✳ is also an emoji; `✳ Jcode hooks` is a Claude task title.
  return (
    Boolean(title) &&
    /jcode/i.test(title ?? '') &&
    !title?.trimStart().startsWith(CLAUDE_IDLE) &&
    JCODE_IDENTITY_TITLE_RE.test(stripJcodeTitleStatus(title ?? ''))
  )
}

// title_with_metrics: `· work ~2m05s` (or `· working`) mid-turn, `· last ~2m05s` after it.
const JCODE_ACTIVITY_TAIL_RE = /\s·\s(?:(work|last)\s~(?:\d+h\d{2}m|\d+m\d{2}s|\d+s)|working)$/u

function jcodeTitleActivity(title: string): 'working' | 'idle' | null {
  const tail = JCODE_ACTIVITY_TAIL_RE.exec(title)
  return tail ? (tail[1] === 'last' ? 'idle' : 'working') : null
}

/** A jcode identity title carries its own activity; without a tail it is at rest. */
export function jcodeIdentityTitleStatus(title: string): 'working' | 'idle' | null {
  return isJcodeIdentityTerminalTitle(title) ? (jcodeTitleActivity(title) ?? 'idle') : null
}

/** Conversation and SSH titles carry only the tail, which is too generic to identify Jcode, so it counts only in a Jcode pane. */
export function jcodePaneTitleStatus(
  title: string,
  agent: string | null | undefined
): 'working' | 'idle' | null {
  return agent === 'jcode' ? jcodeTitleActivity(title) : null
}
