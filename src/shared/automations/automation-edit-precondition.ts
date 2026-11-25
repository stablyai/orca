import type { Automation } from './automation-definition'

export type AutomationEditPrecondition = Pick<Automation, 'on' | 'bot'> & {
  schedule?: Pick<Automation, 'rrule' | 'dtstart' | 'timezone' | 'timezoneExplicit'>
}

export const AUTOMATION_CHANGED = 'automation_changed'

export function automationEditPrecondition(automation: Automation): AutomationEditPrecondition {
  const { on, bot, rrule, dtstart, timezone, timezoneExplicit } = automation
  return { on, bot, schedule: { rrule, dtstart, timezone, timezoneExplicit } }
}

/** Object key order and omitted undefined fields survive an RPC round trip. */
export function sameAutomationEditValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : inner
    )
  return canonical(left) === canonical(right)
}
