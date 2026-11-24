// The bot's automations as its Automations tab lists them, paused ones included.
import { indexLatestAutomationRuns } from '../automation-last-run'
import type {
  AutomationConnectorEventTrigger,
  AutomationEventTrigger
} from '../automation-event-triggers'
import type { Automation } from '../automations/automation-definition'
import {
  getAutomationRunLastRunAt,
  type AutomationRun,
  type AutomationRunStatus
} from '../automations/history/automation-run'
import { compareNumericLocaleText } from '../i18n/locale-text-collators'
import type { AutomationOnce } from '../automation-once'

/** The fields the rows sort and flag by; the phone reads only these. */
export type BotAutomationRowFacts = Pick<Automation, 'id' | 'name' | 'enabled' | 'nextRunAt'>

type TriggerFacts<T> = T extends unknown
  ? Pick<T, Extract<keyof T, 'id' | 'source' | 'event' | 'in' | 'subject' | 'names'>>
  : never

/**
 * What a client words of an event: where it listens, by name where saved. Its filter text, people and
 * webhook settings stay on the host.
 */
export type BotAutomationTrigger = TriggerFacts<AutomationEventTrigger>

/** What a client lists of an automation; never its prompt or precheck. */
export type BotAutomationFacts = Pick<
  Automation,
  'id' | 'name' | 'enabled' | 'nextRunAt' | 'updatedAt' | 'dtstart' | 'rrule' | 'workspaceId'
> & {
  on?: BotAutomationTrigger[]
  bot?: { botId: string }
  once?: AutomationOnce
}

function placeFacts(
  trigger: AutomationConnectorEventTrigger
): Pick<AutomationConnectorEventTrigger, 'in' | 'subject' | 'names'> {
  const places = [...(trigger.in ?? []), ...(trigger.subject ? [trigger.subject] : [])]
  const names = Object.fromEntries(
    places.flatMap((place) => (trigger.names?.[place] ? [[place, trigger.names[place]]] : []))
  )
  return {
    ...(trigger.in ? { in: trigger.in } : {}),
    ...(trigger.subject ? { subject: trigger.subject } : {}),
    ...(Object.keys(names).length > 0 ? { names } : {})
  }
}

// One case per arm keeps each source paired with its own events.
function triggerFacts(trigger: AutomationEventTrigger): BotAutomationTrigger {
  switch (trigger.source) {
    case 'slack':
      return {
        id: trigger.id,
        source: trigger.source,
        event: trigger.event,
        ...placeFacts(trigger)
      }
    case 'github':
      return {
        id: trigger.id,
        source: trigger.source,
        event: trigger.event,
        ...placeFacts(trigger)
      }
    case 'linear':
      return {
        id: trigger.id,
        source: trigger.source,
        event: trigger.event,
        ...placeFacts(trigger)
      }
    case 'webhook':
      return { id: trigger.id, source: trigger.source, event: trigger.event }
    case 'gmail':
      return { id: trigger.id, source: trigger.source, event: trigger.event }
    case 'calendar':
      return { id: trigger.id, source: trigger.source, event: trigger.event }
  }
}

/** What `botAutomationFacts` reads of an automation. */
export type BotAutomationFactsSource = Pick<
  Automation,
  | 'id'
  | 'name'
  | 'enabled'
  | 'nextRunAt'
  | 'updatedAt'
  | 'dtstart'
  | 'rrule'
  | 'workspaceId'
  | 'on'
  | 'bot'
  | 'once'
>

export function botAutomationFacts(automation: BotAutomationFactsSource): BotAutomationFacts {
  const { id, name, enabled, nextRunAt, updatedAt, dtstart, rrule, workspaceId } = automation
  return {
    id,
    name,
    enabled,
    nextRunAt,
    updatedAt,
    dtstart,
    rrule,
    workspaceId,
    ...(automation.on ? { on: automation.on.map(triggerFacts) } : {}),
    ...(automation.bot ? { bot: { botId: automation.bot.botId } } : {}),
    ...(automation.once ? { once: automation.once } : {})
  }
}

export type BotAutomationRow<A extends BotAutomationRowFacts = BotAutomationFacts> = {
  key: string
  automation: A
  /** The last run failed, so the automation is listed first. */
  failing: boolean
  /** Its newest run stopped for a sign-in the owner must give; absent from hosts before this field. */
  needsSignIn?: boolean
  /** That newest run, for a failing or sign-in row to open; absent from hosts before this field. */
  latestRunId?: string
  /** When the automation was made, for lists in a fixed order; absent from hosts before this field. */
  createdAt?: number
  /** Its newest run, paused or not; absent with no runs and from hosts before this field. */
  lastRun?: BotAutomationLastRun
}

export type BotAutomationLastRun = { status: AutomationRunStatus; at: number }

/** The run facts the rows read. */
export type BotAutomationRunFacts = Pick<
  AutomationRun,
  | 'id'
  | 'automationId'
  | 'createdAt'
  | 'status'
  | 'dispatchedAt'
  | 'startedAt'
  | 'occurrenceCount'
  | 'lastOccurrenceAt'
>

/** Failing first, then by next run; paused ones last, by name. */
export function buildBotAutomationRows<A extends BotAutomationRowFacts>(
  automations: readonly A[],
  runs: readonly BotAutomationRunFacts[]
): BotAutomationRow<A>[] {
  const latestRuns = indexLatestAutomationRuns(runs)
  return automations
    .map((automation): BotAutomationRow<A> => {
      const newest = latestRuns.get(automation.id)
      const latest = automation.enabled ? newest : undefined
      const failing = latest?.status === 'dispatch_failed'
      const needsSignIn = latest?.status === 'skipped_needs_interactive_auth'
      return {
        key: automation.id,
        automation,
        failing,
        ...(needsSignIn ? { needsSignIn: true } : {}),
        ...(latest && (failing || needsSignIn) ? { latestRunId: latest.id } : {}),
        ...(newest
          ? { lastRun: { status: newest.status, at: getAutomationRunLastRunAt(newest) } }
          : {})
      }
    })
    .sort(
      (a, b) =>
        Number(b.automation.enabled) - Number(a.automation.enabled) ||
        Number(b.failing) - Number(a.failing) ||
        (a.automation.enabled
          ? a.automation.nextRunAt - b.automation.nextRunAt
          : compareNumericLocaleText(a.automation.name, b.automation.name))
    )
}

/** The rows a host sends with Activity. */
export function botAutomationRows(
  automations: readonly Automation[],
  runs: readonly BotAutomationRunFacts[]
): BotAutomationRow[] {
  const createdAt = new Map(automations.map((automation) => [automation.id, automation.createdAt]))
  return buildBotAutomationRows(automations.map(botAutomationFacts), runs).map((row) => ({
    ...row,
    createdAt: createdAt.get(row.automation.id)
  }))
}
