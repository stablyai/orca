import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { agentSessionTranscriptRows } from '../conversation-context/agent-session-context-clear'

// A row list maps to the earlier list it differs from only by streamed message text.
const textOnlyBases = new WeakMap<
  readonly AgentJournalRenderItem[],
  readonly AgentJournalRenderItem[]
>()

/** Everything but the text of a message's blocks, which streaming alone changes. */
function shape(item: AgentJournalRenderItem): string | null {
  const { body } = item
  if (body.kind !== 'message' || body.role === 'user') {
    return null
  }
  const { revision: _revision, ...row } = item
  return JSON.stringify({ ...row, body: { ...body, blocks: body.blocks.map((b) => b.type) } })
}

export function onlyStreamedTextChanged(
  prior: AgentJournalRenderItem,
  next: AgentJournalRenderItem
): boolean {
  const before = shape(prior)
  return before !== null && before === shape(next)
}

export function noteStreamedTextRevision(
  next: readonly AgentJournalRenderItem[],
  base: readonly AgentJournalRenderItem[]
): void {
  textOnlyBases.set(next, textOnlyBases.get(base) ?? base)
}

const floorCuts = new WeakMap<
  readonly AgentJournalRenderItem[],
  { floor: number; rows: readonly AgentJournalRenderItem[] }
>()

/** Rows at or past a `/clear` floor. Streamed text never moves a row across it, so the cut of a
 *  text-only revision stays linked to the cut of its base, and memos over it hold while it streams. */
export function streamedRowsFromFloor(
  items: readonly AgentJournalRenderItem[],
  floor: number
): readonly AgentJournalRenderItem[] {
  const fromFloor = (rows: readonly AgentJournalRenderItem[]) =>
    agentSessionTranscriptRows(rows, floor)
  const shown = fromFloor(items)
  const base = rowsBesideStreamedText(items)
  if (base !== items && shown !== items) {
    let cut = floorCuts.get(base)
    if (cut?.floor !== floor) {
      cut = { floor, rows: fromFloor(base) }
      floorCuts.set(base, cut)
    }
    noteStreamedTextRevision(shown, cut.rows)
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
