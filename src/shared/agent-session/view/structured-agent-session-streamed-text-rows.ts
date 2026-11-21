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
