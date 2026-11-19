import * as z from 'zod'
import { BOT_ITEM_STATUSES } from '../bots/bot-items'
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
  /** With any `--status`, written as a comment; with needs-you, the question for the owner. */
  comment: OptionalString
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
  closedCursor: OptionalString
})

/** Events after `after`, oldest first; or with `newest`, the newest page before `before`. */
export const BotItemsOwnerShow = z.object({
  item: Item,
  after: OptionalString,
  newest: z.boolean().optional(),
  before: OptionalString
})

/** `images`: committed chat-attachment store paths on the bot's host; files ride in `text` as `@path`. */
export const BotItemsOwnerComment = z
  .object({
    ...Owner,
    item: Item,
    text: z.string(),
    images: z
      .array(z.string().min(1).max(4096))
      .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT, 'Comments take up to 20 images.')
      .optional()
  })
  .refine((value) => value.text.trim() || value.images?.length, 'Missing text')

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
