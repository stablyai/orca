import {
  countImagePromptMarkers,
  nativeChatUserMessageImageEvidenceCount,
  nativeChatUserMessageMatchText,
  nativeChatUserTextMatchText,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from '../../../../shared/native-chat-image-transcript-markers'
import { isImageRefBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'

export type NativeChatPendingOccurrence = {
  text: string
  imagePaths?: readonly string[]
  sentAt: number
  afterMessageId?: string | null
  afterMessageTimestamp?: number | null
  matchingOccurrence?: number
  matchingAfterTimestamp?: number
}

export function normalizeNativeChatPendingText(text: string): string {
  return normalizeNativeChatUserText(text)
}

/** Message-side rule (`nativeChatUserMessageMatchText`) applied to a send: only
 *  a send that actually carried images can own an `[Image #n]` marker, so on
 *  every other send the marker is literal text and has to key verbatim. */
function nativeChatPendingMatchText(
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>
): string {
  return nativeChatUserTextMatchText(pending.text, Boolean(pending.imagePaths?.some(Boolean)))
}

function nativeChatTextContentKey(text: string, imageCount: number): string {
  return imageCount > 0 ? `text:${text}\0images:${imageCount}` : `text:${text}`
}

export function nativeChatPendingContentKey(
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>
): string {
  const text = nativeChatPendingMatchText(pending)
  const imagePaths = pending.imagePaths?.filter(Boolean) ?? []
  if (text) {
    return nativeChatTextContentKey(text, imagePaths.length)
  }
  return imagePaths.length > 0 ? `images:${JSON.stringify(imagePaths)}` : 'empty'
}

/**
 * The literal content keys some pending send is waiting on. A send that carried
 * no image owns its `[Image #n]` run as text, so its key is the literal reading
 * of a row — the only thing that can tell that reading apart from the
 * marker-as-placeholder one, which is byte-identical in the row itself.
 *
 * Derived from the whole pending list rather than the row: it says which readings
 * are spoken for, which never varies with the per-send boundary each count is
 * sliced at. That invariance is why each count builder can rebuild it — the queue
 * is capped at 8 — instead of threading a shared "row is spent" state through.
 */
export function literalContentKeysClaimedByPendings(
  pending: readonly Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>[]
): ReadonlySet<string> {
  const claimed = new Set<string>()
  for (const entry of pending) {
    if (!entry.imagePaths?.some(Boolean)) {
      claimed.add(nativeChatPendingContentKey(entry))
    }
  }
  return claimed
}

function nativeChatUserMessageContentKeys(
  message: NativeChatMessage,
  claimedLiteralKeys?: ReadonlySet<string>
): readonly string[] {
  if (message.role !== 'user') {
    return []
  }
  const keys = new Set<string>()
  const matchText = nativeChatUserMessageMatchText(message) ?? ''
  const hasImageRefs = message.blocks.some(isImageRefBlock)
  if (matchText && !hasImageRefs) {
    const literalKey = nativeChatTextContentKey(matchText, 0)
    keys.add(literalKey)
    // Why: one turn is ONE send, but this row can be read two ways — the user's
    // own `[Image #n]` text, or a host echoing an image send as that marker.
    // Minting both let a single row retire two pendings, so a row showing no
    // photo could retire a send that carried one and delete the user's preview
    // for good. When a send is actually waiting on the literal reading, that
    // reading wins and the row stops there; otherwise the marker reading stands,
    // which is what keeps a marker-only host echo matching.
    if (claimedLiteralKeys?.has(literalKey)) {
      return [...keys]
    }
  }
  const imageCount = nativeChatUserMessageImageEvidenceCount(message)
  const imageText = normalizedNativeChatUserMessageText(message)
  if (imageText && imageCount > 0) {
    keys.add(nativeChatTextContentKey(imageText, imageCount))
  } else if (imageCount > 0) {
    const imagePaths = message.blocks
      .filter(isImageRefBlock)
      .map((block) => block.path)
      .filter((path): path is string => Boolean(path))
    if (imagePaths.length > 0) {
      keys.add(`images:${JSON.stringify(imagePaths)}`)
    }
  }
  return [...keys]
}

export function matchingNativeChatUserContentCounts(
  messages: readonly NativeChatMessage[],
  pending?: readonly Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>[]
): Map<string, number> {
  const claimedLiteralKeys = pending && literalContentKeysClaimedByPendings(pending)
  const counts = new Map<string, number>()
  for (const message of messages) {
    for (const key of nativeChatUserMessageContentKeys(message, claimedLiteralKeys)) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

export function advancedNativeChatUserContentCounts(
  messages: readonly NativeChatMessage[],
  pending?: readonly Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths'>[]
): Map<string, number> {
  const claimedLiteralKeys = pending && literalContentKeysClaimedByPendings(pending)
  const advanced = new Map<string, number>()
  const waiting = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'user') {
      for (const key of nativeChatUserMessageContentKeys(message, claimedLiteralKeys)) {
        waiting.set(key, (waiting.get(key) ?? 0) + 1)
      }
      continue
    }
    for (const [key, count] of waiting) {
      advanced.set(key, (advanced.get(key) ?? 0) + count)
    }
    waiting.clear()
  }
  return advanced
}

/** One identity a row can be matched on: the text, and how many image-carrying
 *  sends that reading of the row can account for. */
export type NativeChatUserTextIdentity = { text: string; imageCount: number }

/** A transcript user row as the glue matcher sees it. `imageCount` is the budget
 *  that lets the row own image-carrying pendings — a folded image turn must stay
 *  glueable, but a text-only row must never consume a send that carried a photo. */
export type NativeChatUserTextRow = NativeChatUserTextIdentity & {
  /** Fallback reading for hosts that echo an image send as bare `[Image #n]` text
   *  with no `[Image: source: …]` turn. There the markers are the only evidence
   *  the photo landed, so they vouch for that many sends. Tried only after the
   *  literal reading fails, so a marker the user actually typed still matches
   *  verbatim first (STA-4363). */
  markerEcho?: NativeChatUserTextIdentity
}

function nativeChatUserTextRow(message: NativeChatMessage): NativeChatUserTextRow | null {
  const text = nativeChatUserMessageMatchText(message)
  if (!text) {
    return null
  }
  // Why: image-ref blocks only, NOT `nativeChatUserMessageImageEvidenceCount` —
  // that counts literal `[Image #n]` text as evidence, which is right for content
  // keys but would let a row showing no photo retire a send that carried one,
  // erasing the user's preview before it lands. Under-counting only costs a
  // duplicate bubble; over-counting loses the photo.
  const imageCount = message.blocks.filter(isImageRefBlock).length
  const markerCount = imageCount === 0 ? countImagePromptMarkers(message) : 0
  const strippedText = markerCount > 0 ? normalizedNativeChatUserMessageText(message) : null
  return strippedText
    ? { text, imageCount, markerEcho: { text: strippedText, imageCount: markerCount } }
    : { text, imageCount }
}

/** User rows that already have a later non-user turn (ready to prune echoes). */
export function advancedNativeChatUserTexts(
  messages: readonly NativeChatMessage[]
): readonly NativeChatUserTextRow[] {
  const advanced: NativeChatUserTextRow[] = []
  const waiting: NativeChatUserTextRow[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const row = nativeChatUserTextRow(message)
      if (row) {
        waiting.push(row)
      }
      continue
    }
    advanced.push(...waiting)
    waiting.length = 0
  }
  return advanced
}

/** All user rows (for hiding optimistic echoes once the turn exists). */
export function matchingNativeChatUserTexts(
  messages: readonly NativeChatMessage[]
): readonly NativeChatUserTextRow[] {
  const rows: NativeChatUserTextRow[] = []
  for (const message of messages) {
    const row = message.role === 'user' ? nativeChatUserTextRow(message) : null
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

/**
 * How many leading pending texts concatenate to exactly `userText`, allowing at
 * most one collapsed space at each send boundary. Covers rapid-send glue
 * ("joke"+"continue" → "joke continue") while still requiring the whole row to
 * be consumed, so unrelated prefixes never match ("hi" ↛ "history").
 *
 * Greedy is exact here: both sides are whitespace-normalized, so a piece never
 * starts with a space and at most one of the two boundary forms can apply.
 */
export function countLeadingPendingTextsGluedToUserText(
  pendingTexts: readonly string[],
  userText: string
): number {
  if (pendingTexts.length === 0 || userText.length === 0) {
    return 0
  }
  let cursor = 0
  for (let index = 0; index < pendingTexts.length; index += 1) {
    const piece = pendingTexts[index]
    if (!piece) {
      return 0
    }
    if (userText.startsWith(piece, cursor)) {
      cursor += piece.length
    } else if (index > 0 && userText.startsWith(` ${piece}`, cursor)) {
      cursor += piece.length + 1
    } else {
      return 0
    }
    if (cursor === userText.length) {
      return index + 1
    }
  }
  return 0
}

/**
 * Mark pending entries represented only by multi-send glue (2+ consecutive
 * optimistic texts concatenated into one transcript user row). Exact single
 * matches stay in the content-key/occurrence path so repeated prompts and
 * send boundaries keep their existing semantics.
 *
 * `userRows` must already be filtered to rows after the oldest entry's send
 * boundary — this matcher has no clock of its own.
 */
export function selectPendingIndicesRepresentedByUserTexts(
  pending: readonly NativeChatPendingOccurrence[],
  userRows: readonly NativeChatUserTextRow[]
): Set<number> {
  const represented = new Set<number>()
  if (pending.length < 2 || userRows.length === 0) {
    return represented
  }
  const remaining = pending.map((entry, index) => ({
    index,
    text: nativeChatPendingMatchText(entry),
    imageCount: entry.imagePaths?.filter(Boolean).length ?? 0
  }))
  for (const row of userRows) {
    // Why: a row can only be the glue of a CONTIGUOUS run of sends, so the scan
    // walks `remaining` in send order (retired sends are spliced out below, so it
    // is already the open list) and stops where the run breaks.
    //
    // A send with no match text — an uncaptioned photo, or one whose whole text
    // was an `[Image #n]` placeholder — can never appear in a glued row. Ahead of
    // the run it separates nothing, so skip it: treating it as a barrier there
    // emptied `open` and killed glue for every row, and since such a send can sit
    // unretired indefinitely that stranded every later pair for the pane's life.
    // Once a run has started it does separate what follows, so it ends the scan —
    // otherwise "fix", photo, "bug" would let a row reading "fix bug" retire
    // "fix" and "bug" around a send that is still in flight.
    const open: typeof remaining = []
    for (const entry of remaining) {
      if (entry.text.length === 0) {
        if (open.length > 0) {
          break
        }
        continue
      }
      open.push(entry)
    }
    const openTexts = open.map((entry) => entry.text)
    let gluedCount = 0
    for (const identity of row.markerEcho ? [row, row.markerEcho] : [row]) {
      const count = countLeadingPendingTextsGluedToUserText(openTexts, identity.text)
      // Why: gluedCount === 1 is an exact match — leave it to occurrence counting.
      if (count < 2) {
        continue
      }
      // Why: a folded image turn must stay glueable, but a row can only own as many
      // image-carrying sends as it actually shows evidence for.
      const gluedImages = open.slice(0, count).reduce((total, entry) => total + entry.imageCount, 0)
      if (gluedImages > identity.imageCount) {
        continue
      }
      gluedCount = count
      break
    }
    if (gluedCount < 2) {
      continue
    }
    for (let i = 0; i < gluedCount; i += 1) {
      const entry = open[i]
      if (!entry) {
        continue
      }
      represented.add(entry.index)
      const at = remaining.findIndex((candidate) => candidate.index === entry.index)
      if (at !== -1) {
        remaining.splice(at, 1)
      }
    }
  }
  return represented
}

export function nativeChatPendingMatchKey(pending: NativeChatPendingOccurrence): string {
  return `${String(pending.afterMessageId)}\0${nativeChatPendingContentKey(pending)}`
}

export function assignNativeChatPendingOccurrence<T extends NativeChatPendingOccurrence>(
  existing: readonly T[],
  entry: T
): T {
  const key = nativeChatPendingMatchKey(entry)
  const matching = existing.filter((candidate) => nativeChatPendingMatchKey(candidate) === key)
  if (matching.length === 0) {
    return entry
  }
  const previousOccurrence = Math.max(
    ...matching.map((candidate, index) => candidate.matchingOccurrence ?? index + 1)
  )
  const first = matching[0]
  // Why: pruning an earlier echo must not let a later identical send reuse the
  // same transcript occurrence, even after the read pages out its boundary.
  return {
    ...entry,
    matchingOccurrence: previousOccurrence + 1,
    matchingAfterTimestamp:
      first?.matchingAfterTimestamp ?? first?.afterMessageTimestamp ?? first?.sentAt
  }
}

export function nativeChatPendingMatchingAfter(pending: NativeChatPendingOccurrence): number {
  return pending.matchingAfterTimestamp ?? pending.afterMessageTimestamp ?? pending.sentAt
}

export function nativeChatPendingOccurrence(
  pending: NativeChatPendingOccurrence,
  alreadyConsumed: number
): number {
  return pending.matchingOccurrence ?? alreadyConsumed + 1
}
