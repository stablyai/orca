import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { agentSessionTranscriptRows } from '../conversation-context/agent-session-context-clear'
import { noteRevisedInPlace, revisedInPlace } from './revised-in-place-lists'

// A row list maps to the earlier list it differs from only by streamed message text.
const textOnlyBases = new WeakMap<
  readonly AgentJournalRenderItem[],
  readonly AgentJournalRenderItem[]
>()

/** A reply or reasoning row minus its blocks and revision; streaming changes neither of these. */
function rowBesideBlocks(item: AgentJournalRenderItem): string | null {
  const { body } = item
  if (body.kind !== 'message' || (body.role !== 'assistant' && body.role !== 'reasoning')) {
    return null
  }
  const { revision: _revision, body: _body, ...row } = item
  const { blocks: _blocks, ...message } = body
  return JSON.stringify({ row, message })
}

/** Whether only the text of reply or reasoning blocks changed: every other block, such as a
 *  subagent's state, and every other field must be the same. */
export function onlyStreamedTextChanged(
  prior: AgentJournalRenderItem,
  next: AgentJournalRenderItem
): boolean {
  const before = rowBesideBlocks(prior)
  if (before === null || before !== rowBesideBlocks(next)) {
    return false
  }
  const priorBlocks = prior.body.kind === 'message' ? prior.body.blocks : []
  const nextBlocks = next.body.kind === 'message' ? next.body.blocks : []
  return (
    priorBlocks.length === nextBlocks.length &&
    priorBlocks.every((block, index) => {
      const other = nextBlocks[index]!
      if (block === other) {
        return true
      }
      if (block.type === 'text' && other.type === 'text') {
        const { text: _before, ...kept } = block
        const { text: _after, ...next } = other
        return JSON.stringify(kept) === JSON.stringify(next)
      }
      return JSON.stringify(block) === JSON.stringify(other)
    })
  )
}

export function noteStreamedTextRevision(
  next: readonly AgentJournalRenderItem[],
  base: readonly AgentJournalRenderItem[]
): void {
  textOnlyBases.set(next, textOnlyBases.get(base) ?? base)
}

const floorCuts = new WeakMap<
  readonly AgentJournalRenderItem[],
  { floor: number; rows: readonly AgentJournalRenderItem[]; tail: boolean }
>()

/** The rows at or past `floor`; a revision in place revises the cut of the rows it revised. */
function cutFromFloor(
  items: readonly AgentJournalRenderItem[],
  floor: number
): readonly AgentJournalRenderItem[] {
  if (floor <= 0) {
    return items
  }
  const cached = floorCuts.get(items)
  if (cached?.floor === floor) {
    return cached.rows
  }
  const revised = revisedInPlace(items)
  const prior = revised && floorCuts.get(revised.from)
  const rows =
    (revised &&
      prior?.floor === floor &&
      prior.tail &&
      reviseTailCut(items, revised.at, prior.rows, floor)) ||
    agentSessionTranscriptRows(items, floor)
  // A cut whose first row starts the list's tail is that whole tail, since it keeps order.
  const tail = rows.length === 0 || rows[0] === items[items.length - rows.length]
  floorCuts.set(items, { floor, rows, tail })
  return rows
}

function reviseTailCut(
  items: readonly AgentJournalRenderItem[],
  at: readonly number[],
  prior: readonly AgentJournalRenderItem[],
  floor: number
): readonly AgentJournalRenderItem[] | undefined {
  const offset = items.length - prior.length
  let rows: AgentJournalRenderItem[] | undefined
  const positions: number[] = []
  for (const index of at) {
    const kept = index >= offset
    if (kept !== items[index]!.sequence >= floor) {
      return undefined
    }
    if (kept && prior[index - offset] !== items[index]) {
      ;(rows ??= prior.slice())[index - offset] = items[index]!
      positions.push(index - offset)
    }
  }
  if (!rows) {
    return prior
  }
  noteRevisedInPlace(rows, prior, positions)
  return rows
}

/** Rows at or past a `/clear` floor. Streamed text never moves a row across it, so the cut of a
 *  text-only revision stays linked to the cut of its base, and memos over it hold while it streams. */
export function streamedRowsFromFloor(
  items: readonly AgentJournalRenderItem[],
  floor: number
): readonly AgentJournalRenderItem[] {
  const shown = cutFromFloor(items, floor)
  const base = rowsBesideStreamedText(items)
  if (base !== items && shown !== items) {
    noteStreamedTextRevision(shown, cutFromFloor(base, floor))
  }
  return shown
}

/** Rows to give a projection that never reads assistant or reasoning text: the same list across a
 *  stream's text revisions, so its memo holds while a reply streams. */
export function rowsBesideStreamedText(
  items: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  return textOnlyBases.get(items) ?? items
}

// A projection of a text-only row revision maps to the projection of the rows it revised.
const textOnlyProjections = new WeakMap<readonly object[], readonly object[]>()

// Any later stage's output for a text-only revision maps to its output for the revised rows.
const textOnlyStages = new WeakMap<object, object>()

/** `next` is `from` with only streamed reply text changed, so a scan that reads no reply text
 *  may keep what it built for `from`. */
export function noteStreamedTextStage<T extends object>(next: T, from: T): void {
  if (next !== from) {
    textOnlyStages.set(next, textOnlyStages.get(from) ?? from)
  }
}

/** The stage output a text-only revision stands for, or the output itself. */
export function stageBesideStreamedText<T extends object>(value: T): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only outputs of one stage are linked.
  return (textOnlyStages.get(value) as T | undefined) ?? value
}
const lastProjection = new WeakMap<
  readonly AgentJournalRenderItem[],
  { inputs: readonly unknown[]; projected: readonly object[] }
>()

/** Links `projected`, built from `rows` and `inputs`, to the last projection of the rows `rows`
 *  revised only in streamed text, when the inputs and the count are the same. */
export function noteStreamedTextProjection<P extends readonly object[]>(
  rows: readonly AgentJournalRenderItem[],
  inputs: readonly unknown[],
  projected: P
): P {
  const base = rowsBesideStreamedText(rows)
  const prior = lastProjection.get(base)
  if (
    prior &&
    prior.projected !== projected &&
    prior.projected.length === projected.length &&
    prior.inputs.length === inputs.length &&
    prior.inputs.every((input, index) => input === inputs[index])
  ) {
    textOnlyProjections.set(projected, textOnlyProjections.get(prior.projected) ?? prior.projected)
  }
  lastProjection.set(base, { inputs, projected })
  return projected
}

/** The function a stage builds its list with; one per stage and chat. */
export type StreamedTextStage = (...args: never[]) => unknown

const lastDerivation = new WeakMap<
  StreamedTextStage,
  { base: readonly object[]; inputs: readonly unknown[]; derived: readonly object[] }
>()

/** Links `derived`, which `owner` built from `source` and `inputs`, to what `owner` last built
 *  when `source` revised that one's source only in streamed text, so the link survives each stage. */
export function noteStreamedTextDerivation<P extends readonly object[]>(
  owner: StreamedTextStage,
  source: readonly object[],
  inputs: readonly unknown[],
  derived: P
): P {
  const base = projectionBesideStreamedText(source)
  const prior = lastDerivation.get(owner)
  if (
    prior &&
    prior.derived !== derived &&
    prior.base === base &&
    prior.derived.length === derived.length &&
    prior.inputs.length === inputs.length &&
    prior.inputs.every((input, index) => input === inputs[index])
  ) {
    textOnlyProjections.set(derived, textOnlyProjections.get(prior.derived) ?? prior.derived)
  }
  lastDerivation.set(owner, { base, inputs, derived })
  return derived
}

/** A projection to give a consumer that never reads streamed text: the same list across a stream's
 *  text revisions, so its memo holds while a reply streams. */
export function projectionBesideStreamedText<T extends object>(
  projected: readonly T[]
): readonly T[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only projections of the same type are linked.
  return (textOnlyProjections.get(projected) as readonly T[] | undefined) ?? projected
}
