/** Validate new/changed schedules strictly; preserve saved runnable legacy oversized steps so unrelated edits do not require re-authoring the cadence (#15895). */
export function acceptsAutomationDraftSchedule(input: {
  customSchedule: string
  savedRrule: string | null
  validate: (schedule: string) => boolean
}): boolean {
  const schedule = input.customSchedule.trim()
  if (input.savedRrule !== null && input.savedRrule.trim() === schedule) {
    return true
  }
  return input.validate(schedule)
}
