// What Orca records about a bot automation run on the message it sends, so a chat draws the run as
// the automation's own row, never as the owner's message. Host-written; a client never sends it.
import * as z from 'zod'
import type { AutomationRunEvent } from '../automation-event-triggers'
import type { WaitEnding } from '../automation-once'
import type { BotAutomationFacts } from '../bots/bot-automation-rows'
import type { AutomationRunTrigger } from './history/automation-run'

/** Who the event's person was to the bot when the run was delivered; never recomputed later. */
export type AutomationRunEventAsker = 'owner' | 'member' | 'other'

/** Orca's record of the event, from the same event the sent text was composed from. */
export type AutomationRunMessageEvent = {
  source: AutomationRunEvent['source']
  event: string
  occurredAt: number
  place?: string
  url?: string
  actor?: string
  /** Run now reused the automation's latest event. */
  replayed?: true
  /** Exactly what was quoted to the bot. */
  text?: string
  /** The event's text was longer than what was quoted. */
  textShortened?: true
  asker?: AutomationRunEventAsker
  webhook?: { hookId: string; callId: string; sample?: true; firstCall?: true }
}

export type AutomationRunMessage = {
  runId: string
  /** As saved when it ran: a wait is deleted after, and a recurring one may be edited. */
  automation: BotAutomationFacts
  trigger: AutomationRunTrigger
  /** When a scheduled run was due; the message's own time is when it ran. */
  scheduledFor?: number
  /** A wait's run: how the wait ended, matching its Wait over card. */
  wait?: WaitEnding
  /** A wait its chat's thread made: the run's answer goes to that thread (chat.toConversation). */
  toConversation?: true
  /** Sent into the chat that owns this thread: replies mid-run go there; the run posts its result. */
  answersThread?: { source: string; externalId: string }
  event?: AutomationRunMessageEvent
  /** UTF-16 length of the saved prompt at the head of the sent text. */
  instructionsLength: number
}

const finite = z.number().finite()
const optionalText = z.string().optional()

const WaitEndingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), at: finite, actor: optionalText }),
  z.object({ kind: z.literal('deadline'), at: finite }),
  z.object({ kind: z.literal('expired'), at: finite })
])

// Every source, so a new one fails to compile until it's read here too.
const EVENT_SOURCES: Record<AutomationRunEvent['source'], true> = {
  slack: true,
  github: true,
  linear: true,
  webhook: true,
  gmail: true,
  calendar: true
}

const EventSourceSchema = z.custom<AutomationRunEvent['source']>(
  (value) => typeof value === 'string' && Object.hasOwn(EVENT_SOURCES, value)
)

// The facts cards read (id, name) are checked; the rest of the snapshot rides along as saved.
const AutomationFactsSchema = z.custom<BotAutomationFacts>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'name' in value &&
    typeof value.name === 'string'
)

const EventSchema = z.object({
  source: EventSourceSchema,
  event: z.string().min(1),
  occurredAt: finite,
  place: optionalText,
  url: optionalText,
  actor: optionalText,
  replayed: z.literal(true).optional(),
  text: optionalText,
  textShortened: z.literal(true).optional(),
  asker: z.enum(['owner', 'member', 'other']).optional(),
  webhook: z
    .object({
      hookId: z.string(),
      callId: z.string(),
      sample: z.literal(true).optional(),
      firstCall: z.literal(true).optional()
    })
    .optional()
})

export const AutomationRunMessageSchema = z.object({
  runId: z.string().min(1),
  automation: AutomationFactsSchema,
  trigger: z.enum(['scheduled', 'event', 'manual']),
  scheduledFor: finite.optional(),
  wait: WaitEndingSchema.optional(),
  toConversation: z.literal(true).optional(),
  answersThread: z.object({ source: z.string(), externalId: z.string() }).optional(),
  event: EventSchema.optional(),
  instructionsLength: z.number().int().nonnegative()
})

/** The run a message records, read from a host of any version; anything malformed is no run. */
export function readAutomationRunMessage(value: unknown): AutomationRunMessage | undefined {
  const parsed = AutomationRunMessageSchema.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const run: AutomationRunMessage = parsed.data
  return run
}

/** The saved prompt the sent text starts with. */
export function automationRunInstructions(text: string, run: AutomationRunMessage): string {
  return text.slice(0, run.instructionsLength)
}

/** A run's Wait over card says what the run row already does: same automation, same ending. Expiry
 *  runs nothing, and a run with no ending (Run now) never stands for a card. */
export function automationRunCoversWaitEnded(
  run: { automation: { id: string }; wait?: WaitEnding },
  card: { automation: { id: string }; ending: WaitEnding }
): boolean {
  return (
    card.ending.kind !== 'expired' &&
    run.wait !== undefined &&
    run.automation.id === card.automation.id &&
    run.wait.kind === card.ending.kind &&
    run.wait.at === card.ending.at
  )
}
