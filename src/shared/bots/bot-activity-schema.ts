// The parse a client applies to a host's bots.activity: the model's rows, narrowed to what a client
// draws, salvaging so a newer host's row kind, dot, origin or status drops a line, not the feed.
import * as z from 'zod'
import type { AgentDotState } from '../agent-dot-state'
import type { AutomationRunStatus } from '../automations/history/automation-run'
import { CONNECTOR_SOURCES } from '../connectors/external-conversation-link'
import {
  hostUnionArms,
  openEnum,
  salvagedField,
  salvagedOptional,
  salvagingArray
} from '../validation/zod-salvage'
import type { BotActivity } from './bot-activity-model'
import type { BotAutomationTrigger } from './bot-automation-rows'
import { SUGGESTION_SOURCES } from './bot-look-around'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const DOT_STATES = hostUnionArms<AgentDotState>({
  working: true,
  monitoring: true,
  blocked: true,
  waiting: true,
  interrupted: true,
  failed: true,
  done: true,
  idle: true,
  unverifiable: true,
  unconfirmed: true,
  permission: true
})

export const AUTOMATION_RUN_STATUSES = hostUnionArms<AutomationRunStatus>({
  pending: true,
  dispatching: true,
  dispatched: true,
  completed: true,
  skipped_precheck: true,
  skipped_missed: true,
  skipped_unavailable: true,
  skipped_needs_interactive_auth: true,
  dispatch_failed: true
})

const dot = openEnum(DOT_STATES, 'idle')

const originSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.looseObject({ kind: z.literal('chat') }),
    z.looseObject({ kind: z.literal('thread'), source: openEnum(CONNECTOR_SOURCES, undefined) }),
    z.looseObject({ kind: z.literal('automation'), name: z.string() }),
    z.looseObject({ kind: z.literal('session'), label: z.string() })
  ])
)

const workerRowSchema = lazyZodSchema(() =>
  z.looseObject({
    kind: z.literal('worker'),
    key: z.string(),
    title: z.string(),
    dot,
    origin: salvagedField('origin', originSchema.nullable(), () => null),
    tool: salvagedOptional(
      'tool',
      z.looseObject({ name: z.string(), input: z.string().nullable() })
    )
  })
)

const runRowSchema = lazyZodSchema(() =>
  z.looseObject({
    kind: z.literal('run'),
    key: z.string(),
    automationName: z.string(),
    status: openEnum(AUTOMATION_RUN_STATUSES, undefined),
    dot: dot.nullable(),
    at: z.number()
  })
)

const threadRowSchema = lazyZodSchema(() =>
  z.looseObject({
    kind: z.literal('thread'),
    key: z.string(),
    title: z.string(),
    source: openEnum(CONNECTOR_SOURCES, undefined),
    dot
  })
)

const activityRowSchema = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [workerRowSchema, runRowSchema, threadRowSchema])
)

const eventTriggerShape = lazyZodSchema(() =>
  z.looseObject({ source: z.string(), event: z.string().optional() })
)

/** What a bot's Automations list sorts, words and toggles. */
export const BotAutomationViewSchema = lazyZodSchema(() =>
  z.looseObject({
    id: z.string().min(1),
    name: z.string(),
    enabled: z.boolean(),
    nextRunAt: z.number(),
    updatedAt: z.number(),
    dtstart: z.number(),
    rrule: z.string(),
    workspaceId: z.string().nullable(),
    // Readers word only `source` and `event`, with a fallback for ones they don't know.
    on: salvagedOptional(
      'on',
      salvagingArray(
        z.custom<BotAutomationTrigger>((value) => eventTriggerShape.safeParse(value).success)
      )
    ),
    bot: salvagedOptional('bot', z.looseObject({ botId: z.string() })),
    once: salvagedOptional('once', z.looseObject({ by: z.number().optional() }))
  })
)

const suggestionSchema = lazyZodSchema(() =>
  z.looseObject({
    id: z.string().min(1),
    title: z.string(),
    why: z.string(),
    ask: z.string(),
    link: salvagedOptional('link', z.string()),
    source: salvagedOptional('source', z.enum(SUGGESTION_SOURCES)),
    createdAt: z.number()
  })
)

const upNextSchema = lazyZodSchema(() =>
  z.looseObject({
    state: z.looseObject({
      lastLookedAt: salvagedOptional('lastLookedAt', z.number()),
      tookMs: salvagedOptional('tookMs', z.number()),
      nextAt: salvagedOptional('nextAt', z.number()),
      running: z.boolean(),
      seenAt: z.number(),
      error: salvagedOptional('error', z.string())
    }),
    items: salvagingArray(suggestionSchema)
  })
)

const automationRowSchema = lazyZodSchema(() =>
  z.looseObject({
    key: z.string(),
    failing: z.boolean(),
    automation: BotAutomationViewSchema,
    // A newer host's unknown status drops the field, so the row says nothing of its last run.
    lastRun: salvagedOptional(
      'lastRun',
      z.looseObject({ status: z.enum(AUTOMATION_RUN_STATUSES), at: z.number() })
    )
  })
)

export const BotActivityViewSchema = lazyZodSchema(() =>
  z.looseObject({
    workers: salvagingArray(workerRowSchema),
    inProgress: salvagingArray(activityRowSchema),
    completed: salvagingArray(activityRowSchema),
    automations: salvagingArray(automationRowSchema),
    waits: salvagingArray(automationRowSchema),
    readAt: salvagedOptional('readAt', z.number()),
    upNext: salvagedOptional('upNext', upNextSchema)
  })
)

export type BotActivityView = z.output<typeof BotActivityViewSchema>
/** Activity as its host read it; `readAt` is taken before its automations are, absent from older hosts. */
export type BotActivityRead = BotActivity & { readAt?: number }
export type BotActivityViewRow = z.output<typeof activityRowSchema>
export type BotActivityViewOrigin = z.output<typeof originSchema>
export type BotAutomationView = z.output<typeof BotAutomationViewSchema>

/** Compiles only while every host row fits the view, so a model change cannot silently drop rows. */
export function botActivityView(activity: BotActivity): BotActivityView {
  return activity
}
