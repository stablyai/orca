// Turns pasted text (a list from a spreadsheet, "Name <a@b.co>" lines from a mail client, comma or
// newline separated) into invite candidates. Validation is advisory; auth re-validates every email.

export const MAX_INVITES_PER_BATCH = 50

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/

export type InviteCandidate = { email: string; valid: boolean }

export function isInviteEmail(value: string): boolean {
  return EMAIL.test(value)
}

/** Splits on commas, semicolons and whitespace; keeps the address inside angle brackets. */
export function splitInviteText(text: string): string[] {
  const out: string[] = []
  // "Ada Lovelace <ada@x.io>" → keep just the bracketed address so the name doesn't split into junk.
  const withoutNames = text.replace(/[^,;\n<>]*<([^<>]+)>/g, ' $1 ')
  for (const raw of withoutNames.split(/[\s,;]+/)) {
    const token = raw
      .trim()
      .replace(/^mailto:/i, '')
      .replace(/^["'(]+|["').]+$/g, '')
    if (token) {
      out.push(token)
    }
  }
  return out
}

/** Adds tokens to an existing list, dropping case-insensitive duplicates and anything past the cap. */
export function mergeInviteCandidates(
  existing: readonly InviteCandidate[],
  tokens: readonly string[]
): InviteCandidate[] {
  const seen = new Set(existing.map((candidate) => candidate.email.toLowerCase()))
  const next = [...existing]
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (seen.has(key) || next.length >= MAX_INVITES_PER_BATCH) {
      continue
    }
    seen.add(key)
    next.push({ email: token, valid: isInviteEmail(token) })
  }
  return next
}
