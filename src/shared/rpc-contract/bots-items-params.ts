import * as z from 'zod'
import { BOT_ITEM_STATUSES } from '../bots/bot-items'
import { BotItemAnswersSchema, BotItemAskSchema } from '../bots/bot-item-ask'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import {
  OptionalBoolean,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

// `orca bot item`: run from a bot's chat, the bot and chat are the caller's; `item` is the number the
// CLI shows, or the item's uid.

const Caller = { callerSessionId: OptionalString, retryRequest: OptionalString }
const Item = requiredString('Name the item by its number.')
/** A group's rooms and threads hold one session per member, and keep each one a member left. */
const BOT_ITEM_LIST_CHATS_MAX = 5_000

export const BotItemsAdd = z.object({
  ...Caller,
  title: requiredString('Missing --title'),
  description: OptionalString,
  doneMeans: OptionalString,
  status: z.enum(['planned', 'working']).optional(),
  links: z.array(z.string()).optional(),
  /** `--for bot:<name>`: the item is made for that bot, through its request mail. */
  forBot: OptionalString,
  /** With `--for`, that bot's chat; alone, another chat of the caller's bot. */
  chat: OptionalString
})

export const BotItemsSet = z.object({
  ...Caller,
  item: Item,
  title: OptionalString,
  description: OptionalPlainString,
  doneMeans: OptionalPlainString,
  status: z.enum(BOT_ITEM_STATUSES).optional(),
  note: OptionalString,
  /** With `--status canceled`, which needs it. */
  reason: OptionalString,
  /** With any `--status`, written as a comment; with needs-you, the question. With `ask`, the readable text a host without asks keeps instead. */
  comment: OptionalString,
  /** With needs-you (`--ask/--option`): the decisions, their choices and their context (`--comment`). */
  ask: BotItemAskSchema.optional()
})

export const BotItemsComment = z.object({
  ...Caller,
  item: Item,
  text: requiredString('Missing --text')
})

export const BotItemsDone = z.object({ ...Caller, item: Item, note: OptionalString })

export const BotItemsCancel = z.object({
  ...Caller,
  item: Item,
  reason: requiredString('Canceling needs a reason: --reason "..."')
})

export const BotItemsLink = z.object({
  ...Caller,
  item: Item,
  refs: z
    .array(z.string())
    .min(1, 'Name what to link: dispatch:<id>, pr:<owner/repo#n>, a URL or a path')
})

export const BotItemsList = z.object({
  callerSessionId: OptionalString,
  botId: OptionalString,
  statuses: z.array(z.enum(BOT_ITEM_STATUSES)).optional(),
  all: OptionalBoolean,
  chat: OptionalString,
  here: OptionalBoolean,
  /** Only items linking this PR, URL or file (a PR URL and `owner/repo#n` match). */
  link: OptionalString,
  limit: OptionalPositiveInt,
  cursor: OptionalString
})

export const BotItemsShow = z.object({
  callerSessionId: OptionalString,
  botId: OptionalString,
  item: Item,
  after: OptionalString,
  limit: OptionalPositiveInt
})

const Owner = { requestId: OptionalString }

/** The owner's panel: one bot's own items, open ones all, closed ones by page. */
export const BotItemsOwnerList = z.object({
  botId: requiredString('Missing bot'),
  /** Only this chat's items, counts included. */
  chatId: OptionalString,
  /** Only these chats' items, counts included; a host before it ignores it, so one chat goes as `chatId`. */
  chatIds: z.array(z.string().min(1)).max(BOT_ITEM_LIST_CHATS_MAX).optional(),
  closedCursor: OptionalString
})

/** Events after `after`, oldest first; or with `newest`, the newest page before `before`. */
export const BotItemsOwnerShow = z.object({
  item: Item,
  after: OptionalString,
  newest: z.boolean().optional(),
  before: OptionalString
})

/** `images`: committed chat-attachment store paths on the bot's host; files ride in `text` as `@path`.
 *  `requestId` only to a host advertising BOTS_ITEM_COMMENT_REQUEST_ID_RUNTIME_CAPABILITY. */
export const BotItemsOwnerComment = z
  .object({
    ...Owner,
    item: Item,
    text: z.string(),
    images: z
      .array(z.string().min(1).max(4096))
      .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT, 'Comments take up to 20 images.')
      .optional(),
    /** The sender's id for this comment: a repeat returns the comment already made. */
    requestId: z.string().min(1).max(128).optional(),
    /** The open question this answers (its event id), with `answers` one per decision and the sender's
     *  `answerId`, the same on every retry: the host writes the answer and moves the item to In
     *  progress in one write and replies `answered: true`. An answer sends empty `text` (the host
     *  spells it out), so a host that predates answers refuses it as "Missing text" instead of keeping
     *  a plain comment that would read as answered. */
    answering: OptionalString,
    answers: BotItemAnswersSchema.optional(),
    answerId: OptionalString
  })
  .refine(
    (value) => value.text.trim() || value.images?.length || value.answering !== undefined,
    'Missing text'
  )
  .refine(
    (value) =>
      (value.answering === undefined) === (value.answers === undefined) &&
      (value.answering === undefined) === (value.answerId === undefined),
    { message: 'An answer names its question, its answers and its answer id.' }
  )
  .refine(
    (value) => value.answering === undefined || (!value.text.trim() && !value.images?.length),
    { message: 'An answer goes without text or images: the host spells it out.' }
  )

/** One status for one or many items; Cancel needs a reason, Needs you may carry a comment. */
export const BotItemsOwnerStatus = z.object({
  ...Owner,
  items: z.array(z.string().min(1)).min(1, 'Name the items').max(200),
  status: z.enum(BOT_ITEM_STATUSES),
  reason: OptionalString,
  comment: OptionalString
})

/** Snooze items until `until` (epoch ms), or bring them back with null. Each item names the newest
 *  event by anyone but the owner that the owner's view showed: a later one refuses the snooze. */
export const BotItemsOwnerSnooze = z.object({
  ...Owner,
  items: z
    .array(z.object({ item: Item, othersLastEventId: requiredString('Missing event') }))
    .min(1, 'Name the items')
    .max(200),
  until: z.number().int().positive().nullable()
})

export const BotItemsOwnerOpened = z.object({ botId: requiredString('Missing bot') })

export type BotItemsAddParams = z.infer<typeof BotItemsAdd>
export type BotItemsListParams = z.infer<typeof BotItemsList>
