export type AutomationMissedOccurrenceRecovery = {
  rrule: string
  dtstart: number
  timezone: string
  nextAt: number
  before: number
  /** Quarantined snapshots retain their partial count and diagnostic without retrying. */
  failure?: string
}

export function isPendingAutomationRecovery(
  recovery: AutomationMissedOccurrenceRecovery | undefined
): boolean {
  return !!recovery && recovery.failure === undefined
}
import type { Automation } from './automation-definition'

export function automationRecoveryQueue(
  automation: Pick<Automation, 'missedOccurrenceRecoveries'>
): AutomationMissedOccurrenceRecovery[] {
  return Array.isArray(automation.missedOccurrenceRecoveries)
    ? automation.missedOccurrenceRecoveries
    : []
}
