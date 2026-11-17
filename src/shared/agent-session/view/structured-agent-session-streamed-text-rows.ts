import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'

// A row list maps to the earlier list it differs from only by streamed message text.
type TextRevision = { base: readonly AgentJournalRenderItem[]; indexes: ReadonlySet<number> }
const textOnlyBases = new WeakMap<readonly AgentJournalRenderItem[], TextRevision>()

/** Everything but the text of a message's blocks, which streaming alone changes. */
function shape(item: AgentJournalRenderItem): string | null {
  const { body } = item
  if (body.kind !== 'message' || body.role === 'user') {
    return null
  }
  const { revision: _revision, ...row } = item
  return JSON.stringify({
    ...row,
    body: {
      ...body,
      blocks: body.blocks.map((block) => {
        if (block.type !== 'text') {
          return block
        }
        const { text: _text, ...rest } = block
        return rest
      })
    }
  })
}

export function onlyStreamedTextChanged(
  prior: AgentJournalRenderItem,
  next: AgentJournalRenderItem
): boolean {
  const before = shape(prior)
  return before !== null && before === shape(next)
}

export function noteStreamedTextRevision(
  next: AgentJournalRenderItem[],
  base: readonly AgentJournalRenderItem[],
  changedIndexes: Iterable<number>
): void {
  const prior = textOnlyBases.get(base)
  textOnlyBases.set(next, {
    base: prior?.base ?? base,
    indexes: new Set([...(prior?.indexes ?? []), ...changedIndexes])
  })
}

/** Known replacements, including skipped frames, without retaining a chain of previous arrays. */
export function streamedTextReplacementIndexes(
  before: readonly AgentJournalRenderItem[],
  after: readonly AgentJournalRenderItem[]
): number[] | null {
  if (before === after) {
    return []
  }
  const prior = textOnlyBases.get(before)
  const next = textOnlyBases.get(after)
  if (!next || next.base !== (prior?.base ?? before)) {
    return null
  }
  const indexes = new Set([...(prior?.indexes ?? []), ...next.indexes])
  return [...indexes].filter((index) => before[index] !== after[index])
}

/** Rows to give a projection that never reads assistant or reasoning text: the same list across a
 *  stream's text revisions, so its memo holds while a reply streams. */
export function rowsBesideStreamedText(
  items: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  return textOnlyBases.get(items)?.base ?? items
}

const transcriptFloors = new WeakMap<
  readonly AgentJournalRenderItem[],
  {
    floor: number
    rows: readonly AgentJournalRenderItem[]
    start: number
  }
>()

/** Filtering a stable transcript floor preserves the reducer's localized replacements. */
export function streamedAgentSessionTranscriptRows(
  items: readonly AgentJournalRenderItem[],
  floor: number
): readonly AgentJournalRenderItem[] {
  if (floor <= 0) {
    return items
  }
  const base = rowsBesideStreamedText(items)
  let cached = transcriptFloors.get(base)
  if (cached?.floor !== floor) {
    let start = 0
    while (start < base.length && base[start]!.sequence < floor) {
      start++
    }
    cached = { floor, start, rows: base.slice(start) }
    transcriptFloors.set(base, cached)
  }
  const indexes = streamedTextReplacementIndexes(base, items)
  if (!indexes) {
    return cached.rows
  }
  const changed = indexes.filter((index) => index >= cached.start)
  if (changed.length === 0) {
    return cached.rows
  }
  const rows = cached.rows.slice()
  for (const index of changed) {
    rows[index - cached.start] = items[index]!
  }
  noteStreamedTextRevision(
    rows,
    cached.rows,
    changed.map((index) => index - cached.start)
  )
  return rows
}
