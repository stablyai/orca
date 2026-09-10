/** A partner candidate as offered by the mention search (subset of `OdooMentionSuggestion`). */
export type OdooMentionCandidate = {
  id: number
  name: string
}

/** The `@query` token currently under the caret, plus where it starts in the draft. */
export type OdooMentionQuery = {
  atIndex: number
  query: string
}

// Matches an `@` that starts a word (after start-of-string or whitespace) followed by a
// run of non-whitespace up to the caret — mirrors the native-chat `$`/`/` trigger parsing.
const MENTION_TRIGGER_RE = /(?:^|\s)@(\S*)$/
// Whitespace or closing punctuation already separates the mention from what
// follows, so no space is inserted in front of it.
const MENTION_TRAILING_SPACE_SKIP_RE = /^[\s,.;:!?)\]}]/

/** Finds the `@` mention token ending at `caret`, or null when none is in progress. */
export function findOdooMentionQuery(value: string, caret: number): OdooMentionQuery | null {
  const before = value.slice(0, caret)
  const match = MENTION_TRIGGER_RE.exec(before)
  if (!match) {
    return null
  }
  const query = match[1]
  return { atIndex: before.length - query.length - 1, query }
}

/** The chatter markup Odoo's backend expects for an inline partner mention. */
export function buildOdooMentionMarkup(candidate: OdooMentionCandidate): string {
  return `<a href="#" data-oe-model="res.partner" data-oe-id="${candidate.id}" class="o_mail_redirect">@${candidate.name}</a>`
}

/**
 * Replaces the `@query` token with the plain `@Name` and returns the next caret
 * position. The draft stays readable while typing; the anchor markup Odoo wants
 * is only woven back in at post time by `resolveOdooMentionMarkup`.
 */
export function applyOdooMentionSelection(
  value: string,
  caret: number,
  mentionQuery: OdooMentionQuery,
  candidate: OdooMentionCandidate
): { value: string; caret: number } {
  const before = value.slice(0, mentionQuery.atIndex)
  const after = value.slice(caret)
  const label = `@${candidate.name}`
  // Why: the trailing space closes the mention token, but adding it before an
  // existing space would double it and before punctuation would post "@Jo , hi".
  const inserted = MENTION_TRAILING_SPACE_SKIP_RE.test(after) ? label : `${label} `
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length }
}

/**
 * Weaves the picked mentions back into the draft as Odoo anchor markup, and
 * reports the partner ids that survived.
 *
 * A picked mention only counts while its `@Name` is still literally in the
 * draft — deleting the text has to drop the notification too, or the recipient
 * would be pinged for a mention the author removed. Candidates are matched
 * longest-first so "@Jo" cannot claim the opening of "@Jo Doe".
 */
export function resolveOdooMentionMarkup(
  draft: string,
  mentions: readonly OdooMentionCandidate[]
): { body: string; partnerIds: number[] } {
  const ordered = [...mentions].sort((a, b) => b.name.length - a.name.length)
  const matchedIds = new Set<number>()
  let body = ''
  let index = 0
  while (index < draft.length) {
    if (draft[index] !== '@' || (index > 0 && !/\s/.test(draft[index - 1] ?? ''))) {
      body += draft[index]
      index += 1
      continue
    }
    const candidate = ordered.find((entry) => draft.startsWith(`@${entry.name}`, index))
    if (!candidate) {
      body += draft[index]
      index += 1
      continue
    }
    body += buildOdooMentionMarkup(candidate)
    matchedIds.add(candidate.id)
    index += candidate.name.length + 1
  }
  return { body, partnerIds: [...matchedIds] }
}
