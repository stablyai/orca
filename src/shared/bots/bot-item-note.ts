// An item note: the quiet line a chat shows for item changes, the bot's own ("Added …", "Updated …")
// or another's (your move, your comment, another of its chats). Display only; the bot never reads it.
import {
  BOT_ITEM_STATUSES,
  botItemCommentImages,
  type BotItemCommentImage,
  type BotItemLinkView,
  type BotItemStatus
} from './bot-items'
import { botItemLinkNames } from './bot-item-link-names'
import type { AgentJournalPosition } from '../agent-session/journal/agent-session-journal-types'

export type BotItemNoteItem = { uid: string; number: number; title: string; status: BotItemStatus }

export type BotItemNoteChange =
  | { event: 'made' }
  | { event: 'status'; from: BotItemStatus; to: BotItemStatus; note?: string }
  | { event: 'edited'; fields: string[]; doneMeans?: string | null }
  | { event: 'commented'; text: string; images?: BotItemCommentImage[] }
  /** `names`: each new link's short name, read against the item's links when the note was made. */
  | { event: 'linked'; refs: string[]; names?: Record<string, string> }

/** One item event, with the item as of that event (its status the one the chip shows). */
export type BotItemNoteEntry = BotItemNoteItem & BotItemNoteChange

/** The bot's chat that made a change another chat's note shows; `title` as it was then. */
export type BotItemNoteChat = { kind: 'chat'; chatId: string; title: string | null; home?: true }

/** Who made the changes: this chat's bot, the owner, or another of the bot's chats (`'other-chat'`:
 *  one gone by then, or a note written before notes named it). */
export type BotItemNoteBy = 'bot' | 'owner' | 'other-chat' | BotItemNoteChat

/** Display-only journal card. `noteId` names it once, so a retried write draws it once. */
export type AgentJournalBotItemNoteItem = {
  kind: 'bot-item-note'
  noteId: string
  by: BotItemNoteBy
  entries: BotItemNoteEntry[]
  /** Mail for this chat that landed in Home because Orca had closed it; Home offers to reopen it. */
  closedChat?: { chatId: string; title: string | null }
}

/** A note as a chat draws it: with the quick changes folded into it (`run`, oldest first, itself
 *  included) when it leads a run of the owner's changes to one item; `at` and `position`, the
 *  latest time and journal place of the bot's notes folded into it. */
export type BotItemNoteView = Omit<AgentJournalBotItemNoteItem, 'kind'> & {
  run?: Omit<AgentJournalBotItemNoteItem, 'kind'>[]
  at?: number
  position?: AgentJournalPosition
}

function statusOf(value: unknown, fallback: BotItemStatus): BotItemStatus {
  return BOT_ITEM_STATUSES.find((status) => status === value) ?? fallback
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** An edited field's new text: null when it was cleared. */
function changedTo(change: unknown): string | null {
  return typeof change === 'object' && change !== null && 'to' in change ? text(change.to) : null
}

/** The note entry for a stored item event; null for one a chat doesn't show. `links`: the item's
 *  links, which name the new ones. */
export function botItemNoteEntry(
  event: { kind: string; data: Record<string, unknown> },
  item: BotItemNoteItem,
  links?: readonly BotItemLinkView[]
): BotItemNoteEntry | null {
  const base = { uid: item.uid, number: item.number, title: item.title }
  switch (event.kind) {
    case 'made':
      return { ...base, status: statusOf(event.data.status, item.status), event: 'made' }
    case 'status': {
      const to = statusOf(event.data.to, item.status)
      const note = text(event.data.note)
      return {
        ...base,
        status: to,
        event: 'status',
        from: statusOf(event.data.from, to),
        to,
        ...(note ? { note } : {})
      }
    }
    case 'edited': {
      const fields: Record<string, unknown> =
        typeof event.data.fields === 'object' && event.data.fields !== null
          ? { ...event.data.fields }
          : {}
      const doneMeans = 'doneMeans' in fields ? changedTo(fields.doneMeans) : undefined
      const title = 'title' in fields ? changedTo(fields.title) : null
      return {
        ...base,
        ...(title ? { title } : {}),
        status: item.status,
        event: 'edited',
        fields: Object.keys(fields),
        ...(doneMeans !== undefined ? { doneMeans } : {})
      }
    }
    case 'commented': {
      const images = botItemCommentImages(event.data)
      return {
        ...base,
        status: item.status,
        event: 'commented',
        text: text(event.data.text) ?? '',
        ...(images.length > 0 ? { images } : {})
      }
    }
    case 'linked': {
      const words = Array.isArray(event.data.links) ? event.data.links : []
      const refs = words.flatMap((word) => (typeof word === 'string' ? [word] : []))
      return {
        ...base,
        status: item.status,
        event: 'linked',
        refs,
        ...(links ? { names: botItemLinkNames(refs, links) } : {})
      }
    }
    default:
      return null
  }
}
