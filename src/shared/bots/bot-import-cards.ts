import { lazyZodSchema } from '../schema/lazy-zod-schema'
// The import plan and summary cards a bot puts in its chat (`orca bot import plan|done`). Older clients and
// the phone paint their `text` as a plain line.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

const line = (max: number) => z.string().trim().min(1).max(max)

/** comes: as it is; changed: comes over with a change; already: a re-run found it here; stays: left behind. */
export const BOT_IMPORT_PLAN_GROUPS = ['comes', 'changed', 'already', 'stays'] as const
export type BotImportPlanGroup = (typeof BOT_IMPORT_PLAN_GROUPS)[number]

export const BOT_IMPORT_PLAN_MAX_ITEMS = 40

export const BotImportPlanItemSchema = lazyZodSchema(() =>
  z.object({
    group: z.enum(BOT_IMPORT_PLAN_GROUPS),
    /** What it is, in the owner's words: "3 schedules", "Who Molty is". */
    what: line(120),
    /** Where it goes here: "Soul", "paused automations". */
    to: line(80).optional(),
    /** One line on why, or what changes. */
    why: line(240)
  })
)

/** What the bot writes for `bot import plan`; Orca adds the bot. */
export const BotImportPlanInputSchema = lazyZodSchema(() =>
  z.object({
    /** The old app, as the owner knows it: "OpenClaw". */
    app: line(60),
    /** The old bot's name. */
    name: line(120),
    /** True when this bot was imported from it before, so the plan only brings what's new. */
    again: z.boolean().optional(),
    items: z.array(BotImportPlanItemSchema).min(1).max(BOT_IMPORT_PLAN_MAX_ITEMS)
  })
)
export type BotImportPlanInput = z.infer<typeof BotImportPlanInputSchema>

export const BotImportPlanSchema = lazyZodSchema(() =>
  BotImportPlanInputSchema.extend({ botId: z.string().min(1) })
)
export type BotImportPlan = z.infer<typeof BotImportPlanSchema>

export const BOT_IMPORT_DONE_KINDS = [
  'soul',
  'memory',
  'abilities',
  'automations',
  'tools',
  'other'
] as const

/** What the bot writes for `bot import done`. */
export const BotImportDoneInputSchema = lazyZodSchema(() =>
  z.object({
    app: line(60),
    name: line(120),
    created: z
      .array(
        z.object({
          kind: z.enum(BOT_IMPORT_DONE_KINDS),
          /** "Soul", "3 automations". */
          what: line(80),
          /** "paused", "12 facts, 6 topics". */
          detail: line(200).optional()
        })
      )
      .max(12),
    /** What stayed in the old app, each in a few words. */
    stayed: z.array(line(80)).max(12),
    /** Schedules that came over paused, so the card says to turn them on once the old bot is off. */
    paused: z.number().int().min(0).max(500)
  })
)
export type BotImportDoneInput = z.infer<typeof BotImportDoneInputSchema>

export const BotImportDoneSchema = lazyZodSchema(() =>
  BotImportDoneInputSchema.extend({ botId: z.string().min(1) })
)
export type BotImportDone = z.infer<typeof BotImportDoneSchema>

export const BOT_IMPORT_PLAN_PRESENTATION = 'bot-import-plan'
export const BOT_IMPORT_DONE_PRESENTATION = 'bot-import-done'

/** The plan as lines, for a client that can't draw the card; the bot reads its own plan back this way too. */
export function botImportPlanText(plan: BotImportPlanInput): string {
  const items = (group: BotImportPlanGroup) =>
    plan.items
      .filter((item) => item.group === group)
      .map((item) => `- ${item.what}${item.to ? ` → ${item.to}` : ''}: ${item.why}`)
  const section = (title: string, group: BotImportPlanGroup) => {
    const lines = items(group)
    return lines.length ? [title, ...lines] : []
  }
  return [
    `Import plan: ${plan.name} from ${plan.app}`,
    ...section('Comes over:', 'comes'),
    ...section('Comes over with changes:', 'changed'),
    ...section('Already here:', 'already'),
    ...section(`Stays in ${plan.app}:`, 'stays'),
    'Answer in this chat: import, or what to leave out.'
  ].join('\n')
}

export function botImportDoneText(done: BotImportDoneInput): string {
  return [
    `${done.name} came over from ${done.app}.`,
    ...done.created.map((entry) => `- ${entry.what}${entry.detail ? `: ${entry.detail}` : ''}`),
    ...(done.stayed.length ? [`Stayed in ${done.app}: ${done.stayed.join(', ')}.`] : []),
    ...(done.paused
      ? [`Turn the automations on once the old bot is switched off in ${done.app}.`]
      : [])
  ].join('\n')
}

export function botImportPlanBody(
  plan: BotImportPlan
): AgentJournalPlainStatusItem & { botImportPlan: BotImportPlan } {
  return {
    kind: 'status',
    text: botImportPlanText(plan),
    presentation: BOT_IMPORT_PLAN_PRESENTATION,
    botImportPlan: plan
  }
}

export function botImportDoneBody(
  done: BotImportDone
): AgentJournalPlainStatusItem & { botImportDone: BotImportDone } {
  return {
    kind: 'status',
    text: botImportDoneText(done),
    presentation: BOT_IMPORT_DONE_PRESENTATION,
    botImportDone: done
  }
}

/** The plan on a journal item, or null when it carries none or one this build can't read. */
export function botImportPlanOf(body: AgentJournalItemBody): BotImportPlan | null {
  if (!('botImportPlan' in body)) {
    return null
  }
  const parsed = BotImportPlanSchema.safeParse(body.botImportPlan)
  return parsed.success ? parsed.data : null
}

export function botImportDoneOf(body: AgentJournalItemBody): BotImportDone | null {
  if (!('botImportDone' in body)) {
    return null
  }
  const parsed = BotImportDoneSchema.safeParse(body.botImportDone)
  return parsed.success ? parsed.data : null
}

/** What the owner's Import sends back: what to bring, and what they unticked. */
export function botImportAnswer(
  plan: Pick<BotImportPlan, 'items'>,
  leftOut: ReadonlySet<number>
): string {
  const chosen = plan.items.filter(
    (item, index) => (item.group === 'comes' || item.group === 'changed') && !leftOut.has(index)
  )
  const dropped = plan.items.filter((_, index) => leftOut.has(index))
  return dropped.length
    ? `Import ${chosen.length === 1 ? 'it' : 'these'}, but leave out: ${dropped.map((item) => item.what).join('; ')}.`
    : 'Import all of it.'
}
