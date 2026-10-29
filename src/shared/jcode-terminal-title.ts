// jcode updates emoji/session/diff/duration titles about once a second (terminal_title.rs); generated codenames are identity, not conversation names.
// Captured provenance: docs/reference/jcode-hook-events.md.
const JCODE_TITLE_STATUS_RE =
  /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*|\s+\u00B7\s+(?:\+\d+\s+-\d+|(?:work|last)\s+~\S+)(?=\s+\u00B7\s+|$)/gu

/** The jcode title with its per-session emoji and live diff/duration segments removed. */
export function stripJcodeTitleStatus(title: string): string {
  return title.replace(JCODE_TITLE_STATUS_RE, '').trim()
}

// jcode, jcode Puppy and self-dev jcode/creek Puppy are identity; user work labels contain more.
const JCODE_IDENTITY_TITLE_RE = /^jcode(?:\/[^\s\u00B7]+)?(?:\s+[^\s\u00B7]+)?$/iu

/** True when a jcode title says only which jcode session this is, not what it is doing. */
export function isJcodeIdentityTerminalTitle(title: string | null | undefined): boolean {
  return Boolean(title) && JCODE_IDENTITY_TITLE_RE.test(stripJcodeTitleStatus(title ?? ''))
}
