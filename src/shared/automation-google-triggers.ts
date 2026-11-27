// Gmail and Calendar automation rules: matched on the host that holds the Google sign-in, so they
// are never sent to Orca Cloud and an older cloud never sees them.

export const GOOGLE_EVENT_SOURCES = ['gmail', 'calendar'] as const
export type GoogleEventSource = (typeof GOOGLE_EVENT_SOURCES)[number]

// The same caps as a connector rule's filters.
const MAX_FILTER_LENGTH = 200
const MAX_ADDRESSES = 10

/**
 * A Gmail or Calendar rule, checked on this host only. `account` is the Google account it listens
 * on; absent means the host's only one.
 */
export type AutomationGoogleTrigger =
  | {
      id: string
      source: 'gmail'
      event: 'new_email'
      account?: string
      /** Sender addresses or domains; matches only mail whose domain check (DMARC) passed. */
      from?: string[]
      /** Addresses the mail went to (To or Cc). */
      to?: string[]
      /** Matched case-insensitively against the subject. */
      subjectContains?: string
      /** A Gmail label, by name or id. */
      label?: string
    }
  | {
      id: string
      source: 'calendar'
      event: 'starting_soon'
      account?: string
      /** A calendar id; absent means the account's primary calendar. */
      calendar?: string
      minutesBefore: number
    }

export function isGoogleTrigger<Rule extends { source: string }>(
  trigger: Rule
): trigger is Extract<Rule, { source: GoogleEventSource }> {
  return trigger.source === 'gmail' || trigger.source === 'calendar'
}

export const MAX_MINUTES_BEFORE = 24 * 60

export function assertGoogleTrigger(trigger: AutomationGoogleTrigger): void {
  const texts =
    trigger.source === 'gmail'
      ? [
          trigger.account,
          trigger.subjectContains,
          trigger.label,
          ...(trigger.from ?? []),
          ...(trigger.to ?? [])
        ]
      : [trigger.account, trigger.calendar]
  if (
    texts.some((text) => (text?.length ?? 0) > MAX_FILTER_LENGTH) ||
    (trigger.source === 'gmail' &&
      ((trigger.from?.length ?? 0) > MAX_ADDRESSES || (trigger.to?.length ?? 0) > MAX_ADDRESSES))
  ) {
    throw new Error(`The ${trigger.source}.${trigger.event} trigger's filters are too long.`)
  }
  if (
    trigger.source === 'calendar' &&
    (!Number.isInteger(trigger.minutesBefore) ||
      trigger.minutesBefore < 0 ||
      trigger.minutesBefore > MAX_MINUTES_BEFORE)
  ) {
    throw new Error(`calendar.starting_soon takes 0 to ${MAX_MINUTES_BEFORE} minutes before.`)
  }
}
