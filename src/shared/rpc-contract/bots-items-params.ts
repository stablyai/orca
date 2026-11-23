import * as z from 'zod'
import {
  BOT_ITEM_COMMENT_FILE_MAX_COUNT,
  BOT_ITEM_LIMITS,
  BOT_ITEM_STATUSES
} from '../bots/bot-items'
import { BotItemAskSchema } from '../bots/bot-item-ask'
import { AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT } from '../agent-session/agent-session-attachments'
import {
  MAX_SKILL_REFS,
  SendSkillRef
} from './structured-agent-session/structured-agent-session-message-params'
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
/** `--file`: absolute paths on the bot's host, copied into the item chat's attachment store. */
const Files = z
  .array(z.string().min(1).max(4096))
  .max(AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT + BOT_ITEM_COMMENT_FILE_MAX_COUNT)
  .optional()
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
  /** With any `--status`, written as a comment. With `ask`, a readable copy of it that this host does not keep. */
  comment: OptionalString,
  /** With needs-you: the comment's body (`--comment`), its question lines (`--ask`) and quick replies (`--option`). */
  ask: BotItemAskSchema.optional(),
  /** Attached to the comment `comment` or `ask` writes. */
  files: Files
})

export const BotItemsComment = z
  .object({
    ...Caller,
    item: Item,
    text: z.string(),
    files: Files
  })
  .refine((value) => value.text.trim() || value.files?.length, 'Missing --text or --file')

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
  closedCursor: OptionalString,
  /** Each item without its description, done means and close note; its own read has them. A host
   *  before it ignores these three and answers whole. */
  summary: OptionalBoolean,
  /** With `closedCursor`: only that Closed page, not the open items again. */
  closedOnly: OptionalBoolean,
  /** How many Closed items this read returns (default one page): a list's loaded depth in one read. */
  closedLimit: z.number().int().min(1).max(BOT_ITEM_LIMITS.listPage).optional(),
  /** Only these items (those still in scope), with the counts: what a notice named as changed. */
  uids: z.array(z.string().min(1)).max(BOT_ITEM_LIMITS.listPageMax).optional()
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
    /** The question this comment answers (a quick reply): refused with `item_changed` if the agent has
     *  since asked another. Only to a host advertising BOTS_ITEM_COMMENT_QUESTION_ID_RUNTIME_CAPABILITY. */
    questionId: z.string().min(1).max(128).optional(),
    /** A comment of its own: it answers no question the agent waits on. Only to a host advertising
     *  BOTS_ITEM_COMMENT_PLAIN_RUNTIME_CAPABILITY. */
    plain: z.literal(true).optional(),
    /** Skills picked in the comment, each by its file on the bot's host. Only to a host advertising
     *  BOTS_ITEM_COMMENT_SKILLS_RUNTIME_CAPABILITY. */
    skills: z.array(SendSkillRef).min(1).max(MAX_SKILL_REFS).optional()
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
