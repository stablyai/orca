import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'

// A row list maps to the earlier list it differs from only by streamed message text.
type TextRevision = { base: readonly unknown[]; indexes: ReadonlySet<number> }
const textOnlyBases = new WeakMap<readonly unknown[], TextRevision>()

/** Everything but the text of a message's blocks, which streaming alone changes. */
function shape(item: AgentJournalRenderItem): string | null {
  const { body } = item
  if (body.kind !== 'message' || (body.role !== 'assistant' && body.role !== 'reasoning')) {
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
        return { ...rest, hasText: block.text.length > 0 }
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

export function noteStreamedTextRevision<T>(
  next: T[],
  base: readonly T[],
  changedIndexes: Iterable<number>
): void {
  const prior = textOnlyBases.get(base)
  textOnlyBases.set(next, {
    base: prior?.base ?? base,
    indexes: new Set([...(prior?.indexes ?? []), ...changedIndexes])
  })
}

/** Known replacements, including skipped frames, without retaining a chain of previous arrays. */
export function streamedTextReplacementIndexes<T>(
  before: readonly T[],
  after: readonly T[]
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
export function rowsBesideStreamedText<T>(items: readonly T[]): readonly T[] {
  return (textOnlyBases.get(items)?.base as readonly T[] | undefined) ?? items
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

/** A row-local map/filter keeps its structural index across text revisions. */
export function createStreamedTextRowProjection<T, U>(
  project: (row: T, index: number) => U | null
) {
  let held: { base: readonly T[]; rows: U[]; at: Map<number, number> } | null = null
  return (items: readonly T[]): U[] => {
    const base = rowsBesideStreamedText(items)
    if (held?.base !== base) {
      const rows: U[] = []
      const at = new Map<number, number>()
      base.forEach((row, index) => {
        const next = project(row, index)
        if (next !== null) {
          at.set(index, rows.length)
          rows.push(next)
        }
      })
      held = { base, rows, at }
    }
    const indexes = streamedTextReplacementIndexes(base, items) ?? []
    if (!indexes.length) {
      return held.rows
    }
    const rows = held.rows.slice()
    const changed: number[] = []
    for (const index of indexes) {
      const at = held.at.get(index)
      const next = project(items[index]!, index)
      if (at !== undefined && next !== null) {
        rows[at] = next
        changed.push(at)
      }
    }
    noteStreamedTextRevision(rows, held.rows, changed)
    return rows
  }
}

const partitionBases = new WeakMap<object, object>()
export function noteStreamedTextPartition<T extends object>(next: T, before: T): void {
  partitionBases.set(next, partitionBases.get(before) ?? before)
}
export function partitionsBesideStreamedText<T extends object>(partitions: T): T {
  return (partitionBases.get(partitions) as T | undefined) ?? partitions
}
