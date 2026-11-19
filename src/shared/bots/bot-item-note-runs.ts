// How a chat draws item changes: the item mail the bot reads stays hidden (its note shows the change),
// the bot's note that only links workers whose Started rows this chat shows stays hidden,
// the owner's quick changes to one item, with nothing shown between them, fold into the first, and the
// bot's notes in one turn, with only tool work between them, fold into the first (its row stays put
// while a live turn adds to it, and shows the latest note's time).
import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { isNativeChatOrcaCard } from '../native-chat/native-chat-orca-card'
import { nativeChatRowRendersContent } from '../native-chat/transcript/row-content/native-chat-row-content'
import { nativeChatRowRendersProse } from '../native-chat/transcript/folding/native-chat-trailing-run'
import { botItemNoteIsQuiet } from './bot-item-note-lines'

/** The sender item mail names. */
export const BOT_ITEM_MAIL_SENDER = 'orca:items'

/** Item mail ids: only Orca's item code mints one, as no send, ask or reply takes a caller's message id. */
export const BOT_ITEM_MAIL_ID_PREFIX = 'msg_item_'

export function isBotItemMail(message: NativeChatMessage): boolean {
  const mail = message.from?.orchestration
  return (
    mail?.message === 'mail-notice' &&
    mail.messages.length > 0 &&
    mail.messages.every((entry) => entry.from === BOT_ITEM_MAIL_SENDER)
  )
}

/** The item one owner status change moved, or null. */
function ownerMoveOf(message: NativeChatMessage): string | null {
  const note = message.botItemNote
  const entry = note?.by === 'owner' && note.entries.length === 1 ? note.entries[0] : undefined
  return entry?.event === 'status' ? entry.uid : null
}

/** Item mail, a folded note, or a row with nothing to draw. */
export function rowDrawsNothing(message: NativeChatMessage): boolean {
  return (
    isBotItemMail(message) ||
    (!isNativeChatOrcaCard(message) && !nativeChatRowRendersContent(message.blocks))
  )
}

function hidden(message: NativeChatMessage): NativeChatMessage {
  return { ...message, blocks: [], botItemNote: undefined }
}

/** Same length and order as `messages`, so per-row facts (`turnKeys`) still line up. */
export function foldBotItemNotes<T extends readonly NativeChatMessage[]>(
  messages: T,
  turnKeys: readonly (string | undefined)[] = []
): T | NativeChatMessage[] {
  if (!messages.some((message) => message.botItemNote || isBotItemMail(message))) {
    return messages
  }
  const out = messages.map((message) => (isBotItemMail(message) ? hidden(message) : message))
  dropOwnWorkerLinks(out, turnKeys)
  foldOwnerMoves(messages, out)
  foldBotTurnNotes(out, turnKeys)
  return out
}

const DISPATCH_REF = 'dispatch:'

/** The Dispatches a note of the bot's links, when linking them is all it does; else null. */
function linkedDispatches(message: NativeChatMessage): string[] | null {
  const note = message.botItemNote
  if (note?.by !== 'bot' || note.entries.length === 0) {
    return null
  }
  const ids: string[] = []
  for (const entry of note.entries) {
    if (entry.event !== 'linked' || entry.refs.length === 0) {
      return null
    }
    for (const ref of entry.refs) {
      if (!ref.startsWith(DISPATCH_REF)) {
        return null
      }
      ids.push(ref.slice(DISPATCH_REF.length))
    }
  }
  return ids
}

/** Matched by Dispatch id, never by name. A link line hides only when each worker's Started row comes
 *  before it, or in its own turn (the live turn often links just before it starts), so a line the
 *  reader already saw never vanishes when a later turn brings the row; another chat's or the owner's
 *  link, or one naming a worker this chat never started, always shows. */
function dropOwnWorkerLinks(
  out: NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): void {
  const started = new Map<string, { index: number; turn: string | undefined }[]>()
  out.forEach((message, index) => {
    const id = message.agentStart ? message.agentStartDispatchId : undefined
    if (id) {
      started.set(id, [...(started.get(id) ?? []), { index, turn: turnKeys[index] }])
    }
  })
  if (started.size === 0) {
    return
  }
  out.forEach((message, index) => {
    const turn = turnKeys[index]
    const shown = (id: string) =>
      started
        .get(id)
        ?.some((row) => row.index < index || (turn !== undefined && row.turn === turn)) === true
    if (linkedDispatches(message)?.every(shown)) {
      out[index] = hidden(message)
    }
  })
}

function foldOwnerMoves(messages: readonly NativeChatMessage[], out: NativeChatMessage[]): void {
  let lead = -1
  for (let index = 0; index < out.length; index++) {
    const message = out[index]!
    const uid = ownerMoveOf(message)
    const leader = lead >= 0 ? out[lead]! : null
    if (uid !== null && leader && ownerMoveOf(messages[lead]!) === uid && leader.botItemNote) {
      const { run = [{ ...messages[lead]!.botItemNote! }], ...note } = leader.botItemNote
      out[lead] = { ...leader, botItemNote: { ...note, run: [...run, message.botItemNote!] } }
      out[index] = hidden(message)
      continue
    }
    if (uid !== null) {
      lead = index
    } else if (!rowDrawsNothing(message)) {
      lead = -1
    }
  }
}

/** Tool calls and reasoning between two notes keep them one row; prose, a person or another card don't. */
function breaksRun(message: NativeChatMessage): boolean {
  return (
    message.role === 'user' || isNativeChatOrcaCard(message) || nativeChatRowRendersProse(message)
  )
}

function foldBotTurnNotes(
  out: NativeChatMessage[],
  turnKeys: readonly (string | undefined)[]
): void {
  let lead = -1
  for (let index = 0; index < out.length; index++) {
    const message = out[index]!
    const turn = turnKeys[index]
    const note = message.botItemNote
    if (note?.by === 'bot' && turn !== undefined) {
      const leader = lead >= 0 ? out[lead]! : null
      if (leader?.botItemNote && turnKeys[lead] === turn) {
        const entries = [...leader.botItemNote.entries, ...note.entries]
        const at = message.timestamp ?? leader.botItemNote.at
        const position = message.journalPosition ?? leader.botItemNote.position
        out[lead] = {
          ...leader,
          botItemNote: {
            ...leader.botItemNote,
            entries,
            ...(at != null ? { at } : {}),
            ...(position ? { position } : {})
          }
        }
        out[index] = hidden(message)
      } else {
        lead = index
      }
    } else if (
      lead >= 0 &&
      !rowDrawsNothing(message) &&
      (turn !== turnKeys[lead] || breaksRun(message))
    ) {
      lead = -1
    }
  }
}

export type BotItemNoteJoin = 'above' | 'below' | 'both'

/** Which sides of each quiet item-note row touch another quiet note, so the two sit close: the
 *  nearest row that draws, past folded and hidden ones (`hidden`: what this surface folded away).
 *  `drawsBelow`: the row carries something under its note (a turn's diff), which keeps them apart. */
export function botItemNoteJoins(
  messages: readonly NativeChatMessage[],
  hidden: (index: number) => boolean,
  drawsBelow: (index: number) => boolean = () => false
): Map<number, BotItemNoteJoin> {
  const drawn = messages.flatMap((message, index) =>
    hidden(index) || rowDrawsNothing(message) ? [] : [index]
  )
  const quiet = (index: number | undefined) => {
    const note = index === undefined ? undefined : messages[index]!.botItemNote
    return note !== undefined && botItemNoteIsQuiet(note)
  }
  const joins = new Map<number, BotItemNoteJoin>()
  drawn.forEach((index, at) => {
    if (!quiet(index)) {
      return
    }
    const previous = drawn[at - 1]
    const above = quiet(previous) && !drawsBelow(previous!)
    const below = quiet(drawn[at + 1]) && !drawsBelow(index)
    if (above || below) {
      joins.set(index, above && below ? 'both' : above ? 'above' : 'below')
    }
  })
  return joins
}
