// The parse a client applies to a host's bots.items.owner.list and .show, salvaging so a newer host's
// link, event or status drops one row, not the whole list.
import * as z from 'zod'
import {
  hostUnionArms,
  openEnum,
  salvagedOptional,
  salvagingArray
} from '../validation/zod-salvage'
import {
  BOT_ITEM_STATUSES,
  type BotItem,
  type BotItemActor,
  type BotItemChatKind,
  type BotItemEvent,
  type BotItemEventKind,
  type BotItemLinkView,
  type BotItemPullRequest,
  type BotItemStatus,
  type BotItemWorkerState
} from './bot-items'

const WORKER_STATES = hostUnionArms<BotItemWorkerState>({
  working: true,
  completed: true,
  failed: true,
  stopped: true,
  unknown: true,
  missing: true
})

const CHAT_KINDS = hostUnionArms<BotItemChatKind>({
  home: true,
  chat: true,
  thread: true,
  automation: true
})

const EVENT_KINDS = hostUnionArms<BotItemEventKind>({
  made: true,
  edited: true,
  status: true,
  commented: true,
  linked: true,
  snoozed: true,
  unsnoozed: true
})

const PR_STATES = hostUnionArms<Extract<BotItemPullRequest, { shown: true }>['state']>({
  open: true,
  draft: true,
  merged: true,
  closed: true
})

const statusSchema = z.enum(BOT_ITEM_STATUSES)

const prSchema: z.ZodType<BotItemPullRequest, unknown> = z.union([
  z.looseObject({
    shown: z.literal(true),
    ref: z.string(),
    number: z.number(),
    url: z.string(),
    state: z.enum(PR_STATES),
    checks: z.string().nullable(),
    review: z.string().nullable(),
    title: salvagedOptional('title', z.string().nullable()),
    checkedAt: z.number().nullable(),
    worktreeId: salvagedOptional('worktreeId', z.string().nullable())
  }),
  z.looseObject({ shown: z.literal(false), reason: z.literal('server') })
])

const linkSchema: z.ZodType<BotItemLinkView, unknown> = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('dispatch'),
    ref: z.string(),
    latest: z.string().nullable(),
    title: z.string().nullable(),
    // A newer worker state reads as unknown: never claimed as finished.
    state: openEnum(WORKER_STATES, 'unknown'),
    host: z.string().nullable(),
    startedAt: z.number().nullable(),
    settledAt: z.number().nullable(),
    report: z.looseObject({ subject: z.string(), body: z.string().nullable() }).nullable(),
    reason: salvagedOptional('reason', z.string().nullable()),
    pr: prSchema.nullable().catch(null)
  }),
  z.looseObject({ kind: z.literal('pr'), ref: z.string(), pr: prSchema.nullable().catch(null) }),
  z.looseObject({
    kind: z.literal('url'),
    ref: z.string(),
    issue: salvagedOptional(
      'issue',
      z.looseObject({ title: z.string(), state: z.enum(['open', 'closed']) })
    )
  }),
  z.looseObject({ kind: z.literal('file'), ref: z.string() }),
  z.looseObject({
    kind: z.literal('automation'),
    ref: z.string(),
    name: z.string().nullable(),
    active: z.boolean()
  })
])

const actorSchema: z.ZodType<BotItemActor, unknown> = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('bot'), botId: z.string(), chatId: z.string() }),
  z.looseObject({ kind: z.literal('owner'), device: salvagedOptional('device', z.string()) }),
  z.looseObject({ kind: z.literal('orca'), why: z.string() })
])

export const BotItemEventSchema: z.ZodType<BotItemEvent, unknown> = z.looseObject({
  id: z.string(),
  kind: z.enum(EVENT_KINDS),
  actor: actorSchema,
  data: z.record(z.string(), z.unknown()),
  at: z.number()
})

export const BotItemSchema: z.ZodType<BotItem, unknown> = z.looseObject({
  uid: z.string(),
  number: z.number(),
  owner: z.looseObject({ botId: z.string(), name: z.string().nullable() }),
  title: z.string(),
  description: z.string().nullable(),
  doneMeans: z.string().nullable(),
  status: statusSchema,
  chat: z.looseObject({
    id: z.string(),
    kind: openEnum(CHAT_KINDS, 'chat'),
    title: z.string().nullable()
  }),
  madeBy: z
    .looseObject({ botId: z.string(), name: z.string().nullable(), chatId: z.string() })
    .nullable(),
  question: z.looseObject({ eventId: z.string(), text: z.string() }).nullable(),
  closeNote: z.string().nullable(),
  // Hosts before Waiting send none.
  wait: z.looseObject({ text: z.string(), at: z.number() }).nullable().catch(null),
  links: salvagingArray(linkSchema),
  version: z.number(),
  lastEventId: z.string(),
  othersLastEventId: z.string(),
  // Hosts before snoozing send none: not snoozed.
  snoozedUntil: z.number().nullable().catch(null),
  lastActivityAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable()
})

export type BotItemsListRead = {
  items: BotItem[]
  counts: Partial<Record<BotItemStatus, number>>
  /** The newest event the owner had seen when the tab was last opened. */
  seenEventId: string
  nextClosedCursor?: string
}

export const BotItemsListReadSchema: z.ZodType<BotItemsListRead, unknown> = z.looseObject({
  items: salvagingArray(BotItemSchema),
  counts: z.partialRecord(statusSchema, z.number()).catch({}),
  seenEventId: z.string(),
  nextClosedCursor: salvagedOptional('nextClosedCursor', z.string())
})

export type BotItemShowRead = {
  item: BotItem
  events: BotItemEvent[]
  nextCursor?: string
  earlierCursor?: string
}

export const BotItemShowReadSchema: z.ZodType<BotItemShowRead, unknown> = z.looseObject({
  item: BotItemSchema,
  events: salvagingArray(BotItemEventSchema),
  nextCursor: salvagedOptional('nextCursor', z.string()),
  earlierCursor: salvagedOptional('earlierCursor', z.string())
})
