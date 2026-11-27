// What one item ended at in a run of the bot's writes, which picks the sentence its note line says.
import type { BotItemNoteEntry } from './bot-item-note'
import { botItemLinkName } from './bot-item-link-names'
import type { BotItemStatus } from './bot-items'

export type BotAct =
  | { act: 'none' | 'ask' | 'done' | 'canceled' | 'comment' | 'update' }
  | { act: 'move'; to: BotItemStatus }
  | { act: 'link'; link: LinkedWords }

/** What one item ended at in a run of the bot's writes: its last status, prefixed with "Added" when
 *  the run made it. A round trip back to where it started isn't a move; an ask is Needs you with its
 *  question (the write puts the comment just before the move) or a comment after it. Comments, links
 *  and edits show only when the status didn't change. */
export function botAct(entries: readonly BotItemNoteEntry[]): { added: boolean } & BotAct {
  const made = entries.find((entry) => entry.event === 'made')
  const moves = entries.flatMap((entry, index) => (entry.event === 'status' ? [index] : []))
  const firstMove = moves.length > 0 ? entries[moves[0]!]! : null
  const start = made
    ? made.status
    : firstMove?.event === 'status'
      ? firstMove.from
      : entries.at(-1)!.status
  const lastMove = moves.at(-1)
  const final = lastMove === undefined ? start : entries[lastMove]!.status
  const settledAt = lastMove ?? (made ? entries.indexOf(made) : -1)
  const asked =
    final === 'needs_you' &&
    entries.some(
      (entry, index) =>
        entry.event === 'commented' &&
        (index > settledAt || (lastMove !== undefined && index === lastMove - 1))
    )
  const added = made !== undefined
  // Asking again while already Needs you is still a question.
  if (asked && (added || lastMove !== undefined)) {
    return { added, act: 'ask' }
  }
  if (final !== start) {
    return final === 'done' || final === 'canceled'
      ? { added, act: final }
      : { added, act: 'move', to: final }
  }
  if (added) {
    return { added, act: 'none' }
  }
  if (entries.some((entry) => entry.event === 'commented')) {
    return { added, act: 'comment' }
  }
  const link = linkedWords(entries)
  return link ? { added, act: 'link', link } : { added, act: 'update' }
}

/** `dispatchId`: the one link's worker, when it is one. */
type LinkedWords = { count: number; name: string | null; dispatchId?: string }

/** The links a write added: the one link's short name, or how many. */
function linkedWords(entries: readonly BotItemNoteEntry[]): LinkedWords | null {
  const names = new Map<string, string | null>()
  for (const entry of entries) {
    if (entry.event !== 'linked') {
      continue
    }
    for (const ref of entry.refs) {
      // An older note has no names: its PRs read #n.
      const name =
        entry.names?.[ref] ?? botItemLinkName(ref, { homeRepo: null, workerTitle: () => null })
      names.set(ref, name)
    }
  }
  const [only] = names.values()
  if (only === undefined) {
    return null
  }
  const [ref = ''] = names.keys()
  return names.size === 1 && ref.startsWith('dispatch:')
    ? { count: 1, name: only, dispatchId: ref.slice('dispatch:'.length) }
    : { count: names.size, name: names.size === 1 ? only : null }
}
