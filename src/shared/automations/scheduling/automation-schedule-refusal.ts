/** Refusal text for new schedule input: what was wrong, then every accepted form. */
const ACCEPTED_SCHEDULE_FORMS =
  'a 5-field cron expression such as "*/10 * * * *" (every 10 minutes), or an RRULE of FREQ=HOURLY with BYMINUTE, FREQ=DAILY with BYHOUR and BYMINUTE, or FREQ=WEEKLY with BYDAY, BYHOUR and BYMINUTE'

export type AutomationScheduleRefusalHints = {
  /** Named forms the caller expands before the schedule reaches this check, e.g. presets. */
  extraForms?: string
  /** How the caller schedules a single run, offered when input carries a start or end. */
  oneTimeRun?: string
}

export function formatScheduleRefusal(
  schedule: string,
  label: string,
  ignoredPart: string | null,
  hints: AutomationScheduleRefusalHints
): string {
  const sentences = [label]
  if (/(^|\n)\s*RRULE:/i.test(schedule)) {
    sentences.push('Drop the "RRULE:" prefix.')
  }
  if (ignoredPart !== null) {
    sentences.push(`RRULE part ${JSON.stringify(ignoredPart)} is not supported.`)
  }
  if (/\b(DTSTART|UNTIL|COUNT)\b/i.test(schedule)) {
    sentences.push(
      [
        'Schedules repeat until removed, so DTSTART, UNTIL and COUNT are not supported.',
        hints.oneTimeRun
      ]
        .filter(Boolean)
        .join(' ')
    )
  }
  const forms = hints.extraForms
    ? `${hints.extraForms}, ${ACCEPTED_SCHEDULE_FORMS}`
    : ACCEPTED_SCHEDULE_FORMS
  sentences.push(`Use ${forms}.`)
  return sentences.join(' ')
}
