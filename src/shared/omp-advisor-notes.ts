// OMP advisor cards: the notes an advisor model injected into the primary
// session, and the one identity that collapses their three carriers.
//
// An accepted `advise` call lands in the primary transcript as a
// `customType: 'advisor'` custom message (docs/advisor-watchdog.md, verified
// against session-advisors.ts) carrying the notes TWICE: structured in
// `details.notes`, and agent-facing as XML-escaped `<advisory>` elements in
// `content`. Orca sees the same card from three directions — the on-disk
// transcript, the RPC `message_start`/`message_end` frames, and a hydrated
// `get_messages_page` history — so every carrier keys on `ompAdvisorTurnId`
// and the highest-priority copy wins the assembler's cross-source dedupe.

export const OMP_ADVISOR_CUSTOM_TYPE = 'advisor'

/** The only severities the `advise` tool accepts. There is deliberately no
 *  `recap` member — the recap is TUI-rendered and unrelated (wave 12). */
export const OMP_ADVISOR_SEVERITIES = ['nit', 'concern', 'blocker'] as const
export type OmpAdvisorSeverity = (typeof OMP_ADVISOR_SEVERITIES)[number]

export type OmpAdvisorNote = {
  note: string
  severity?: OmpAdvisorSeverity
  /** Absent for the implicit default advisor; a WATCHDOG.yml roster entry's name otherwise. */
  advisor?: string
}

type AdvisorCardRecord = {
  customType?: unknown
  content?: unknown
  details?: unknown
}

export function isOmpAdvisorCard(record: unknown): boolean {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as AdvisorCardRecord).customType === OMP_ADVISOR_CUSTOM_TYPE
  )
}

/**
 * The notes on one advisor card. `details.notes` is preferred — it is the
 * producer's own structured record — and the `<advisory>` element parse is the
 * floor for a carrier that dropped `details` (extension metadata is documented
 * as not reaching the model, so a future wire shape may omit it).
 */
export function readOmpAdvisorNotes(record: unknown): OmpAdvisorNote[] {
  if (!isOmpAdvisorCard(record)) {
    return []
  }
  const card = record as AdvisorCardRecord
  const structured = readStructuredNotes(card.details)
  return structured.length > 0 ? structured : parseAdvisoryElements(advisorCardText(card.content))
}

function readStructuredNotes(details: unknown): OmpAdvisorNote[] {
  if (typeof details !== 'object' || details === null) {
    return []
  }
  const notes = (details as { notes?: unknown }).notes
  if (!Array.isArray(notes)) {
    return []
  }
  const parsed: OmpAdvisorNote[] = []
  for (const entry of notes) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const record = entry as { note?: unknown; severity?: unknown; advisor?: unknown }
    const note = buildNote(record.note, record.severity, record.advisor)
    if (note) {
      parsed.push(note)
    }
  }
  return parsed
}

/** `content` is a string or a `(TextContent | ImageContent)[]`; only text carries advisories. */
function advisorCardText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'object' && item !== null) {
      const block = item as { type?: unknown; text?: unknown }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

const ADVISORY_ELEMENT = /<advisory([^>]*)>([\s\S]*?)<\/advisory>/g
const ADVISORY_ATTRIBUTE = /(\w+)="([^"]*)"/g

function parseAdvisoryElements(text: string): OmpAdvisorNote[] {
  if (!text.includes('<advisory')) {
    return []
  }
  const notes: OmpAdvisorNote[] = []
  for (const match of text.matchAll(ADVISORY_ELEMENT)) {
    const attributes = readAdvisoryAttributes(match[1])
    const note = buildNote(unescapeXml(match[2]), attributes.severity, attributes.advisor)
    if (note) {
      notes.push(note)
    }
  }
  return notes
}

function readAdvisoryAttributes(raw: string): { severity?: string; advisor?: string } {
  const attributes: { severity?: string; advisor?: string } = {}
  for (const match of raw.matchAll(ADVISORY_ATTRIBUTE)) {
    if (match[1] === 'severity') {
      attributes.severity = unescapeXml(match[2])
    } else if (match[1] === 'advisor') {
      attributes.advisor = unescapeXml(match[2])
    }
  }
  return attributes
}

/** Inverse of OMP's escapeXmlText/escapeXmlAttribute, which emit exactly these
 *  four entities and never a numeric reference (packages/utils/src/sanitize-text.ts). */
const XML_ENTITY = /&(amp|lt|gt|quot);/g
const XML_ENTITY_TEXT: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"'
}

function unescapeXml(value: string): string {
  return value.replace(XML_ENTITY, (_match, entity: string) => XML_ENTITY_TEXT[entity])
}

function buildNote(note: unknown, severity: unknown, advisor: unknown): OmpAdvisorNote | null {
  if (typeof note !== 'string' || note.trim() === '') {
    return null
  }
  const trimmedAdvisor = typeof advisor === 'string' ? advisor.trim() : ''
  return {
    note: note.trim(),
    ...(isAdvisorSeverity(severity) ? { severity } : {}),
    ...(trimmedAdvisor ? { advisor: trimmedAdvisor } : {})
  }
}

function isAdvisorSeverity(value: unknown): value is OmpAdvisorSeverity {
  return OMP_ADVISOR_SEVERITIES.includes(value as OmpAdvisorSeverity)
}

/**
 * Cross-carrier identity for one advisor card, used as the chat message's
 * `turnId`. Content-derived because no carrier supplies a usable id: the
 * transcript envelope, the wire frame, and a hydrated history page each stamp
 * their own. Whitespace-normalized so the XML body's wrapping newlines match
 * the structured note verbatim; severity and advisor name are folded in so two
 * advisors raising identical text stay distinct rows.
 *
 * Normalization is limited to what a carrier actually rewrites, because
 * anything else makes the encoding non-injective and silently drops a card:
 * `appendOmpRpcAdvisorCard` treats a colliding turnId as a duplicate, so two
 * distinct notes sharing one identity render as one. The XML carrier really
 * does re-wrap prose across lines, hence the whitespace collapse; nothing
 * rewrites letter case, so `Check Foo` and `Check foo` stay distinct cards.
 *
 * `timestamp` is the card's OWN epoch-ms clock, and content alone is not
 * enough without it: an advisor may legitimately re-raise identical text after
 * a reset or history rewrite, and a content-only key would hand the new card
 * the older one's identity — so the overlay would read the stale transcript
 * row as coverage and suppress live advice that has no other carrier. The
 * clock is safe to fold in because all three carriers report the same instant:
 * `SessionManager.appendCustomMessageEntry` stamps the persisted entry with
 * the CustomMessage's own `timestamp` (session-manager.ts), and the hydrated
 * page lifts that same field into the envelope slot
 * (omp-rpc-history-decode.ts). Null for a carrier that dropped it, which
 * degrades to the content-only key rather than inventing a clock.
 */
export function ompAdvisorTurnId(
  notes: readonly OmpAdvisorNote[],
  timestamp: number | null
): string | null {
  if (notes.length === 0) {
    return null
  }
  const parts = notes.map((note) =>
    [
      escapeIdentityField(note.advisor ?? ''),
      escapeIdentityField(note.severity ?? ''),
      escapeIdentityField(note.note.replace(/\s+/g, ' ').trim())
    ].join('/')
  )
  return `omp-advisor:${timestamp ?? ''}:${parts.join('|')}`
}

/** Note text is model prose and may contain the delimiters themselves, so it
 *  is escaped rather than assumed clean: unescaped, one note reading `x|//y`
 *  and the two notes `x` and `y` encode identically, and the second card would
 *  be dropped as a duplicate. */
function escapeIdentityField(value: string): string {
  return value.replace(/[\\/|]/g, (character) => `\\${character}`)
}

/** One labelled block per note, matching the marker prefix the subagent roster
 *  and recap rows already use for OMP-authored, non-conversational content. */
export function ompAdvisorNotesText(notes: readonly OmpAdvisorNote[]): string {
  return notes
    .map((note) => {
      const label = [note.advisor, note.severity].filter((part) => part).join(' · ')
      return `${label ? `※ advisor · ${label}` : '※ advisor'}\n${note.note}`
    })
    .join('\n\n')
}
