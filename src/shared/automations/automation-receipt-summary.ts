import type { BotAutomationFacts, BotAutomationTrigger } from '../bots/bot-automation-rows'
import { botAutomationWhenParts } from '../bots/bot-automation-when'
import type { AutomationScheduleDescriptor } from './scheduling/automation-schedules'
import {
  readAutomationReceiptFacts,
  type AutomationReceiptTriggerExtra
} from './automation-receipt-facts'

export type AutomationReceiptStart =
  | { kind: 'schedule'; schedule: AutomationScheduleDescriptor; zone: string | null }
  | { kind: 'event'; trigger: BotAutomationTrigger; extra: AutomationReceiptTriggerExtra | null }
  | { kind: 'deadline'; at: number }
  | { kind: 'unknown' }

/** Lists retained base starts; extra coverage does not prove original-start completeness. */
export function automationReceiptStarts(
  automation: BotAutomationFacts,
  value: unknown,
  shortened = false
): AutomationReceiptStart[] {
  const decoded = shortened ? undefined : readAutomationReceiptFacts(value)
  const facts = decoded && !('unavailable' in decoded) ? decoded : undefined
  const extras = new Map(facts?.triggerExtras.items.map((extra) => [extra.triggerId, extra]))
  const duplicateIds = new Set<string>()
  for (const trigger of automation.on ?? []) {
    if (duplicateIds.has(trigger.id)) {
      extras.delete(trigger.id)
    }
    duplicateIds.add(trigger.id)
  }
  const starts: AutomationReceiptStart[] = botAutomationWhenParts(automation).map((part) => {
    if (part.kind === 'schedule') {
      return {
        ...part,
        zone: facts?.zone.kind === 'effective-at-save' ? facts.zone.iana : null
      }
    }
    const extra = extras.get(part.trigger.id)
    const google = part.trigger.source === 'gmail' || part.trigger.source === 'calendar'
    return {
      ...part,
      extra:
        extra && (google ? extra.google?.kind === part.trigger.source : !extra.google)
          ? extra
          : null
    }
  })
  if (automation.once?.by !== undefined) {
    if (
      starts.length === 0 &&
      (facts?.triggerExtras.coverage !== 'complete' || facts.triggerExtras.items.length !== 0)
    ) {
      starts.push({ kind: 'unknown' })
    }
    starts.push({ kind: 'deadline', at: automation.once.by })
  }
  return starts.length ? starts : [{ kind: 'unknown' }]
}

export function automationReceiptStartDetails(
  automation: BotAutomationFacts,
  value: unknown,
  shortened = false
): { start: AutomationReceiptStart; showLabel: boolean }[] {
  const starts = automationReceiptStarts(automation, value, shortened)
  const showLabel =
    !automation.enabled ||
    starts.length > 2 ||
    starts.filter((start) => start.kind === 'event').length > 1
  return starts
    .filter((start) => showLabel || start.kind === 'event')
    .map((start) => ({ start, showLabel }))
}
