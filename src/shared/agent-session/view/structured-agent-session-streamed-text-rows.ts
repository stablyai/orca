import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'

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

/** Rows to give a projection that never reads assistant or reasoning text: the same list across a
 *  stream's text revisions, so its memo holds while a reply streams. */
export function rowsBesideStreamedText(
  items: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  return textOnlyBases.get(items) ?? items
}
