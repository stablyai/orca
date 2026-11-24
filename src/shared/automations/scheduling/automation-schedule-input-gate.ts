/**
 * Decides when the editor's strict schedule gate applies.
 *
 * The gate judges a schedule the user is introducing or changing. A cadence already saved and
 * still running is left alone: rows written before the oversized-step refusal (#15895) stay
 * valid to run but not to re-enter, and re-judging one would block edits that never touched
 * the schedule — a rename, a prompt change — behind re-authoring it.
 */
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
