/** True when the automation's schedule (rrule) trigger is on. Absent
 *  `scheduleEnabled` (automations persisted before the field existed) counts as
 *  enabled, so the schedule keeps firing without a migration — hence the
 *  parameter accepts the field as optional. This gates the schedule trigger
 *  only — the master `enabled` flag and the webhook trigger are checked
 *  separately, so a scheduled run requires `enabled && this`. */
export function isScheduleTriggerEnabled(automation: { scheduleEnabled?: boolean }): boolean {
  return automation.scheduleEnabled !== false
}

/** Whether a scheduled run should fire now: the automation is enabled (master
 *  switch), its schedule trigger is on, and the next occurrence is due. The
 *  scheduler evaluates this per tick. Webhook triggers are gated separately. */
export function isScheduledAutomationDue(
  automation: { enabled: boolean; nextRunAt: number; scheduleEnabled?: boolean },
  now: number
): boolean {
  return automation.enabled && isScheduleTriggerEnabled(automation) && automation.nextRunAt <= now
}
