// ngit automation rules: matched on the host, which reads the repository's relays itself, so they
// are never sent to Orca Cloud and an older cloud never sees them.

/** A client declaring it reads ngit rules; an older one is sent automations without them. */
export const NGIT_TRIGGERS_RUNTIME_CAPABILITY = 'ngit.triggers.v1' as const

export const NGIT_EVENT_KINDS = [
  'issue_opened',
  'pr_opened',
  'pr_pushed',
  'pr_merged',
  'pr_closed',
  'issue_closed',
  'comment'
] as const

export type NgitEventKind = (typeof NGIT_EVENT_KINDS)[number]

/** `from=anyone`: anyone on Nostr, which a rule must ask for by name. */
export const NGIT_ANYONE = 'anyone'

export type AutomationNgitTrigger = {
  id: string
  source: 'ngit'
  event: NgitEventKind
  /** `nostr://` URLs of the repositories to watch. */
  in: string[]
  /** Matched case-insensitively against the event's title and text. */
  textContains?: string
  /** One issue or pull request, by at least the first 8 hex characters of its event id. */
  subject?: string
  /** Public keys (npub), or `anyone`; absent means the repository's maintainers. */
  from?: string[]
}

// The same caps as a connector rule's filters.
const MAX_FILTER_LENGTH = 200
const MAX_VALUES = 10
const SUBJECT_PATTERN = /^[0-9a-f]{8,64}$/

export function isNgitTrigger<Rule extends { source: string }>(
  trigger: Rule
): trigger is Extract<Rule, { source: 'ngit' }> {
  return trigger.source === 'ngit'
}

export function assertNgitTrigger(trigger: AutomationNgitTrigger): void {
  const lists = [trigger.in, trigger.from ?? []]
  if (
    lists.some((list) => list.length > MAX_VALUES) ||
    [trigger.textContains, ...lists.flat()].some((text) => (text?.length ?? 0) > MAX_FILTER_LENGTH)
  ) {
    throw new Error(`The ngit.${trigger.event} trigger's filters are too long.`)
  }
  if (trigger.in.length === 0 || !trigger.in.every((url) => url.startsWith('nostr://'))) {
    throw new Error(`ngit.${trigger.event} needs in= to name a nostr:// repository.`)
  }
  if (trigger.subject !== undefined && !SUBJECT_PATTERN.test(trigger.subject)) {
    throw new Error('subject= takes the first 8 or more hex characters of an event id.')
  }
}
