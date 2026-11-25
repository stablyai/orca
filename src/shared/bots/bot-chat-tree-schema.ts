// The parse a client applies to a host's bots.chatTree, salvaging so a newer host's state, origin or
// note drops a row or a field, not the whole tree.
import * as z from 'zod'
import {
  hostUnionArms,
  openEnum,
  salvagedOptional,
  salvagingArray,
  salvagingRecord
} from '../validation/zod-salvage'
import type {
  BotChatOrigin,
  BotChatTreeChat,
  BotChatTreeRead,
  BotChatTreeWorker
} from './bot-chat-tree'
import type { BotChatSearchResult } from './bot-chat-search'

const WORKER_STATES = hostUnionArms<BotChatTreeWorker['state']>({
  running: true,
  'needs-you': true,
  'asking-bot': true,
  unreachable: true,
  done: true,
  failed: true
})

const WORKER_NOTES = hostUnionArms<NonNullable<BotChatTreeWorker['note']>>({
  'handed-over': true,
  'from-closed-chat': true,
  'automation-terminal': true
})

const ORIGINS = hostUnionArms<BotChatOrigin>({
  home: true,
  slack: true,
  linear: true,
  github: true,
  automation: true,
  side: true
})

const LIVE = hostUnionArms<BotChatTreeChat['live']>({
  replying: true,
  'needs-you': true,
  idle: true
})

const workerSchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  branch: salvagedOptional('branch', z.string()),
  state: z.enum(WORKER_STATES),
  startedAt: z.number(),
  settledAt: salvagedOptional('settledAt', z.number()),
  settledUndated: salvagedOptional('settledUndated', z.literal(true)),
  worktreeId: salvagedOptional('worktreeId', z.string()),
  paneKey: salvagedOptional('paneKey', z.string()),
  note: salvagedOptional('note', z.enum(WORKER_NOTES)),
  waitsOnBackground: salvagedOptional('waitsOnBackground', z.literal(true)),
  dispatchId: salvagedOptional('dispatchId', z.string()),
  hostId: salvagedOptional('hostId', z.string()),
  agent: salvagedOptional('agent', z.string()),
  summary: salvagedOptional('summary', z.string())
})

const chatSchema = z.looseObject({
  chatId: z.string(),
  title: z.string(),
  // A newer origin draws as a side chat.
  origin: openEnum(ORIGINS, 'side'),
  originLabel: salvagedOptional('originLabel', z.string()),
  live: openEnum(LIVE, 'idle'),
  lastActiveAt: z.number(),
  unread: z.boolean(),
  turnDone: salvagedOptional('turnDone', z.looseObject({ paneKey: z.string(), at: z.number() })),
  closed: z.boolean(),
  closedAt: salvagedOptional('closedAt', z.number()),
  tab: salvagedOptional('tab', z.boolean()),
  unseen: salvagedOptional('unseen', z.boolean()),
  run: salvagedOptional(
    'run',
    z.looseObject({
      automationId: z.string(),
      runId: z.string(),
      worktreeId: z.string().optional(),
      paneKey: z.string().optional()
    })
  ),
  preview: salvagedOptional('preview', z.string()),
  running: salvagingArray(workerSchema),
  runningTotal: z.number(),
  finished: salvagingArray(workerSchema),
  finishedTotal: z.number(),
  failedTotal: z.number()
})

export const BotChatTreeReadSchema: z.ZodType<BotChatTreeRead, unknown> = z.looseObject({
  chats: salvagingArray(chatSchema),
  workspaceChats: salvagingRecord(z.string(), z.string())
})

/** `bots.chats.search`'s answer; a newer host's chat shape drops a row, not the answer. */
export const BotChatSearchResultSchema: z.ZodType<BotChatSearchResult, unknown> = z.looseObject({
  chats: salvagingArray(chatSchema),
  matches: salvagingArray(
    z.looseObject({ chatId: z.string(), workerKeys: z.array(z.string()).nullable() })
  ),
  more: z.number()
})
