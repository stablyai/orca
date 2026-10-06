// jcode paints `<emoji> jcode <session-name>[ · +N -M][ · work|last ~<dur>]` about once
// a second (crates/jcode-tui/src/tui/app/terminal_title.rs). The tail is live status,
// the emoji is picked per session and swapped mid-turn, and the head is jcode's own
// name plus the codename it generates ("Puppy", "Tigress") — a label, never a
// conversation name. Captured titles are in docs/reference/jcode-hook-events.md.
const JCODE_TITLE_STATUS_RE =
  /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*|\s+·\s+(?:\+\d+\s+-\d+|(?:work|last)\s+~\S+)(?=\s+·\s+|$)/gu

/** The jcode title with its per-session emoji and live diff/duration segments removed. */
export function stripJcodeTitleStatus(title: string): string {
  return title.replace(JCODE_TITLE_STATUS_RE, '').trim()
}

// `jcode`, `jcode Puppy`, and `jcode/creek Puppy` (the self-dev variant) are all
// identity; anything the user could recognise as their own work has more to it.
const JCODE_IDENTITY_TITLE_RE = /^jcode(?:\/[^\s·]+)?(?:\s+[^\s·]+)?$/iu

/** True when a jcode title says only which jcode session this is, not what it is doing. */
export function isJcodeIdentityTerminalTitle(title: string | null | undefined): boolean {
  return Boolean(title) && JCODE_IDENTITY_TITLE_RE.test(stripJcodeTitleStatus(title ?? ''))
}
