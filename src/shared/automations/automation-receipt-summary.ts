import type { BotAutomationFacts, BotAutomationTrigger } from '../bots/bot-automation-rows'
import { botAutomationWhenParts } from '../bots/bot-automation-when'
import type { AutomationScheduleDescriptor } from './scheduling/automation-schedules'
import {
  readAutomationReceiptFacts,
  type AutomationReceiptTriggerExtra
} from './automation-receipt-facts'

export type AutomationReceiptStart =
  | { kind: 'schedule'; schedule: AutomationScheduleDescriptor; zone: string | null }
  | {
      kind: 'event'
      trigger: BotAutomationTrigger
      extra: AutomationReceiptTriggerExtra | null
      /** A shortened transport may have clipped place strings; only the event kind is exact. */
      placeWithheld?: true
    }
  | { kind: 'deadline'; at: number }
  | { kind: 'unknown' }

export type AutomationReceiptStartSet = {
  starts: AutomationReceiptStart[]
  /**
   * A wait whose original alternatives are not proven complete: legacy, partial, shortened or
   * incoherent receipt evidence. The listed starts are true, but may not be every alternative.
   */
  alternativesUnproven: boolean
}

function extraMatches(
  trigger: BotAutomationTrigger,
  extra: AutomationReceiptTriggerExtra
): boolean {
  const google = trigger.source === 'gmail' || trigger.source === 'calendar'
  return google ? extra.google?.kind === trigger.source : !extra.google
}

/** Retained base starts with only the extras that join one base trigger unambiguously. */
export function automationReceiptStartSet(
  automation: BotAutomationFacts,
  value: unknown,
  shortened = false
): AutomationReceiptStartSet {
  const decoded = shortened ? undefined : readAutomationReceiptFacts(value)
  const facts = decoded && !('unavailable' in decoded) ? decoded : undefined
  const items = facts?.triggerExtras.items ?? []
  const extras = new Map<string, AutomationReceiptTriggerExtra>()
  const ambiguous = new Set<string>()
  for (const extra of items) {
    if (extras.has(extra.triggerId)) {
      ambiguous.add(extra.triggerId)
    }
    extras.set(extra.triggerId, extra)
  }
  const baseIds = new Set<string>()
  for (const trigger of automation.on ?? []) {
    if (baseIds.has(trigger.id)) {
      ambiguous.add(trigger.id)
    }
    baseIds.add(trigger.id)
  }
  for (const id of ambiguous) {
    extras.delete(id)
  }
  let coherent = ambiguous.size === 0 && items.length === baseIds.size
  const starts: AutomationReceiptStart[] = botAutomationWhenParts(automation).map((part) => {
    if (part.kind === 'schedule') {
      return {
        ...part,
        zone: facts?.zone.kind === 'effective-at-save' ? facts.zone.iana : null
      }
    }
    const candidate = extras.get(part.trigger.id)
    const extra = candidate && extraMatches(part.trigger, candidate) ? candidate : null
    coherent &&= extra !== null
    return { ...part, extra, ...(shortened ? { placeWithheld: true as const } : {}) }
  })
  // Complete means coherent extras for every event of an intact base, per the saved V1 delta.
  const complete = facts?.triggerExtras.coverage === 'complete' && coherent
  if (automation.once) {
    if (starts.some((start) => start.kind === 'schedule')) {
      // Why: the scheduler rejects recurrence on a wait, so this stored pair is contradictory.
      return { starts: [{ kind: 'unknown' }], alternativesUnproven: false }
    }
    if (automation.once.by !== undefined) {
      starts.push({ kind: 'deadline', at: automation.once.by })
    }
    if (!starts.length) {
      return { starts: [{ kind: 'unknown' }], alternativesUnproven: false }
    }
    // Unknown alternatives qualify the wait, with or without a deadline; they are never listed
    // as another trigger.
    return { starts, alternativesUnproven: !complete }
  }
  return { starts: starts.length ? starts : [{ kind: 'unknown' }], alternativesUnproven: false }
}

export function automationReceiptStarts(
  automation: BotAutomationFacts,
  value: unknown,
  shortened = false
): AutomationReceiptStart[] {
  return automationReceiptStartSet(automation, value, shortened).starts
}

export function automationReceiptStartDetails(
  automation: BotAutomationFacts,
  value: unknown,
  shortened = false
): {
  scopes: { start: AutomationReceiptStart; showLabel: boolean }[]
  alternativesUnproven: boolean
} {
  const { starts, alternativesUnproven } = automationReceiptStartSet(automation, value, shortened)
  const showLabel =
    !automation.enabled ||
    starts.length > 2 ||
    starts.filter((start) => start.kind === 'event').length > 1
  return {
    scopes: starts
      .filter((start) => showLabel || start.kind === 'event')
      .map((start) => ({ start, showLabel })),
    alternativesUnproven
  }
}
