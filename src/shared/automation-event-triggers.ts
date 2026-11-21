import type { Automation } from './automations/automation-definition'
import type { AutomationRun } from './automations/history/automation-run'
import { hookIdOfRule, type WebhookFilters } from './connector-webhook-contract'
import { assertAutomationOnce } from './automation-once'
import { assertGitHubFilters, assertWorkflowWait } from './automation-github-triggers'
import {
  assertGoogleTrigger,
  isGoogleTrigger,
  type AutomationGoogleTrigger,
  type GoogleEventSource
} from './automation-google-triggers'

/**
 * What each source can start a bot automation on. Anyone in a place the bot and its owner are in may
 * fire one, unless its `from` names people; Who can ask gates only asking the bot.
 */
export const AUTOMATION_EVENT_KINDS = {
  slack: ['mentioned', 'message', 'reaction'],
  github: [
    'issue_opened',
    'pr_opened',
    'pr_pushed',
    'pr_merged',
    'comment',
    'review_comment',
    'review',
    'mentioned',
    'review_requested',
    'assigned',
    'ci_failed',
    'ci_passed',
    'pr_conflicted',
    'pr_closed',
    'pr_ready',
    'labeled',
    'issue_closed',
    'deploy_finished',
    'security_alert',
    'workflow_finished'
  ],
  linear: ['assigned', 'mentioned', 'issue_created', 'issue_moved'],
  // The automation's own URL; whoever holds its key or signature can call it.
  webhook: ['call'],
  // Checked on the host that holds the Google sign-in; never sent to Orca Cloud.
  gmail: ['new_email'],
  calendar: ['starting_soon']
} as const

/**
 * The one event a rule's `fromOwner` may take. On GitHub the bot works as its owner, so the owner's
 * other events (pushes, comments, reviews) would start it on its own work; a pull request the owner
 * opens is told from one a bot's worker opened by its head branch (own-pr-trigger-guard.ts).
 */
export const OWN_EVENT_KINDS = [{ source: 'github', event: 'pr_opened' }] as const

export function takesOwnEvents(trigger: { source: string; event: string }): boolean {
  return OWN_EVENT_KINDS.some(
    (kind) => kind.source === trigger.source && kind.event === trigger.event
  )
}

export type AutomationEventSource = keyof typeof AUTOMATION_EVENT_KINDS
/** One source's event, as `AUTOMATION_EVENT_KINDS` lists it. */
export type AutomationEventKind = {
  [Source in AutomationEventSource]: {
    source: Source
    event: (typeof AUTOMATION_EVENT_KINDS)[Source][number]
  }
}[AutomationEventSource]

/** A source and event read as text (a shared bot's suggestion), when they name a real event. */
export function automationEventKind(source: string, event: string): AutomationEventKind | null {
  if (!Object.hasOwn(AUTOMATION_EVENT_KINDS, source)) {
    return null
  }
  const kinds: Record<string, readonly string[]> = AUTOMATION_EVENT_KINDS
  if (!kinds[source].includes(event)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: source is a key of AUTOMATION_EVENT_KINDS and event is in its list, checked just above.
  return { source, event } as AutomationEventKind
}

/** The sources Orca Cloud delivers: a connector app's events. */
export type ConnectorEventSource = Exclude<AutomationEventSource, 'webhook' | GoogleEventSource>

/** One rule that starts the automation; the filters narrow where it listens. */
export type AutomationEventTrigger =
  | AutomationConnectorEventTrigger
  | AutomationWebhookTrigger
  | AutomationGoogleTrigger

export function isConnectorSource(source: AutomationEventSource): source is ConnectorEventSource {
  return source !== 'webhook' && !isGoogleTrigger({ source })
}

/** A Slack, GitHub or Linear rule: the ones Orca Cloud matches. */
export function isConnectorTrigger(
  trigger: AutomationEventTrigger
): trigger is AutomationConnectorEventTrigger {
  return !isWebhookTrigger(trigger) && !isGoogleTrigger(trigger)
}

/** A Slack, GitHub or Linear rule. */
export type AutomationConnectorEventTrigger = {
  [Source in ConnectorEventSource]: {
    /** Stable, so run history and the cloud's copy can name it. */
    id: string
    source: Source
    event: (typeof AUTOMATION_EVENT_KINDS)[Source][number]
    /** Slack channel ids, GitHub "owner/name" repos or Linear team keys ("ENG"); absent listens wherever the bot hears. */
    in?: string[]
    /** Matched case-insensitively against the event's text. */
    textContains?: string
    /** github.labeled only: that label, in any case. */
    label?: string
    /** github.workflow_finished only: the one GitHub Actions run, by its id, in the repo `in` names. */
    run?: string
    /** One PR or issue to follow: "owner/name#482" or "ENG-123". */
    subject?: string
    /** Only these people's events, by their id in the source; absent means anyone. */
    from?: string[]
    /** A Slack reaction only on a message the bot's owner wrote. */
    onOwnerMessage?: true
    /** The owner's own events count too, beside anyone `from` names; with no `from`, only theirs.
     *  github.pr_opened only (OWN_EVENT_KINDS): the bot works as its owner on GitHub. */
    fromOwner?: true
    /** Display names ("#orca", "Nora") by the in, subject or from value they name; never matched. */
    names?: Record<string, string>
  }
}[ConnectorEventSource]

/**
 * The automation's webhook, id webhookRuleId(hookId); at most one per automation. A new one is sent
 * with id '' and rev 0, and the host fills both in when Orca Cloud makes the hook.
 */
export type AutomationWebhookTrigger = WebhookFilters & {
  id: string
  source: 'webhook'
  event: 'call'
  /** Raised on each filter edit; the id, and so the URL, stays. */
  rev: number
}

/**
 * The rule with `names` cut to its own in, subject and from values, each within the cloud's display
 * cap; absent when none is named. Saved automations from before names have none.
 */
export function withTriggerNames(
  rule: AutomationConnectorEventTrigger,
  names: Readonly<Record<string, string | undefined>>
): AutomationConnectorEventTrigger {
  const values = [...(rule.in ?? []), ...(rule.subject ? [rule.subject] : []), ...(rule.from ?? [])]
  const kept = Object.fromEntries(
    values.flatMap((value) => {
      const name = names[value]?.trim()
      return name ? [[value, name.slice(0, MAX_TRIGGER_FILTER_LENGTH)]] : []
    })
  )
  const named: AutomationConnectorEventTrigger = { ...rule, names: kept }
  if (Object.keys(kept).length === 0) {
    delete named.names
  }
  return named
}

export function isWebhookTrigger(
  trigger: AutomationEventTrigger
): trigger is AutomationWebhookTrigger {
  return trigger.source === 'webhook'
}

/** The automation's webhook rule, if it has one. */
export function automationWebhookTrigger(
  automation: Pick<Automation, 'on'>
): AutomationWebhookTrigger | undefined {
  return automation.on?.find(isWebhookTrigger)
}

/** What Orca alone knows about a webhook call, shown outside the quote. */
export type AutomationRunWebhookCall = {
  hookId: string
  callId: string
  /** The call's body, relative to the bot's folder; null when it couldn't be written. */
  file: string | null
  sample?: true
  /** The hook's first call that isn't a sample. */
  firstCall?: true
}

/** The event a run was started by. Its text is someone else's words, so it is only ever quoted. */
export type AutomationRunEvent = {
  triggerId: string
  source: AutomationEventSource
  event: AutomationEventTrigger['event']
  /** The source's own id for the event; one run per key. */
  key: string
  /** The thread, PR or issue; later events on it fold into its unfinished run. */
  subject?: string
  occurredAt: number
  /** Display strings: who did it and where ("Dana Lee", "#infra"). */
  actor?: string
  /** The service's id for who did it, and whether that was the bot's owner, as the cloud stamped them;
   *  a bot request from the run is for that person. Absent on a webhook's call and older runs. */
  actorId?: string
  fromOwner?: true
  place?: string
  url?: string
  text?: string
  webhook?: AutomationRunWebhookCall
  /** A Gmail or Calendar event: the account it came on and Orca's ref for the mail or event. */
  google?: { account: string; ref: string }
  /** The cloud conversation the event came in; a run that answers in the thread links to it. */
  conversation?: { source: AutomationConnectorEventTrigger['source']; externalId: string }
  /** The chat that already owns that thread, and whom it acts for (null: not recorded, so the owner
   *  only), as the cloud found it; a run may go into it instead of taking the thread. */
  threadOwner?: {
    conversation: { source: AutomationConnectorEventTrigger['source']; externalId: string }
    actsFor: string | null
  }
}

// Said where --results-to thread is refused because the host's Orca Cloud can't bind the thread.
export const THREAD_REPLIES_UNSUPPORTED =
  "Orca Cloud doesn't support this yet: results can't go to the event's thread. Send them to the Chat or a channel instead."

export const MAX_AUTOMATION_EVENT_TRIGGERS = 20
// The cloud's caps on a rule; it drops a rule over them, which would then never fire.
const MAX_TRIGGER_PLACES = 10
const MAX_TRIGGER_ID_LENGTH = 128
const MAX_TRIGGER_FILTER_LENGTH = 200
// A run remembers this many folded events; a resend older than that is past any source's retries.
const MAX_RUN_EVENT_KEYS = 50
export const MAX_AUTOMATION_EVENT_TEXT_LENGTH = 4096

/** An automation that starts only on events keeps a schedule no Orca reaches, so an older Orca never runs it. */
export const EVENT_ONLY_SCHEDULE = {
  rrule: 'FREQ=DAILY;BYHOUR=0;BYMINUTE=0',
  dtstart: Date.UTC(9999, 0, 1)
} as const

export function hasAutomationSchedule(automation: Pick<Automation, 'dtstart'>): boolean {
  return automation.dtstart < EVENT_ONLY_SCHEDULE.dtstart
}

/** Nothing but its webhook starts it, so the automation can't outlive the webhook. */
export function webhookIsOnlyStart(automation: Pick<Automation, 'on' | 'dtstart'>): boolean {
  return (
    !hasAutomationSchedule(automation) &&
    (automation.on ?? []).every((trigger) => isWebhookTrigger(trigger))
  )
}

/** Whether the source event already reached this run, as its latest event or a folded one. */
export function runHasEvent(run: Pick<AutomationRun, 'event' | 'eventKeys'>, key: string): boolean {
  return run.event?.key === key || (run.eventKeys?.includes(key) ?? false)
}

/**
 * The run after folding `event` into it. It keeps the latest event by when it happened, so a late
 * resend of an older one never replaces it, and remembers every other event's key.
 */
export function withFoldedEvent<Run extends Pick<AutomationRun, 'event' | 'eventKeys'>>(
  run: Run,
  event: AutomationRunEvent
): Run {
  const [latest, older] =
    run.event && run.event.occurredAt > event.occurredAt ? [run.event, event] : [event, run.event]
  return {
    ...run,
    event: latest,
    eventKeys: [...(run.eventKeys ?? []), ...(older ? [older.key] : [])].slice(-MAX_RUN_EVENT_KEYS)
  }
}

// A thread is only an event's: a schedule, a webhook call or the bot's Chat has none to answer in.
function assertThreadResults(automation: Automation): void {
  const triggers = automation.on ?? []
  if (hasAutomationSchedule(automation) || triggers.length === 0) {
    throw new Error("Results can go to the event's thread only when events alone start it.")
  }
  if (triggers.some(isWebhookTrigger)) {
    throw new Error('A webhook call has no thread; send its results somewhere else.')
  }
  if (triggers.some((trigger) => isGoogleTrigger(trigger))) {
    throw new Error('A Gmail or Calendar event has no thread; send its results somewhere else.')
  }
  if (automation.bot?.runsIn !== 'new') {
    throw new Error(
      "A run that answers in the event's thread needs its own conversation (--runs-in new)."
    )
  }
}

export function assertAutomationEventTriggers(automation: Automation): void {
  if (automation.bot?.resultsTo === 'thread') {
    assertThreadResults(automation)
  }
  const triggers = automation.on ?? []
  if (automation.once) {
    assertOnceStarts(automation)
  } else if (!hasAutomationSchedule(automation) && triggers.length === 0) {
    throw new Error('An automation needs a schedule or an event to start it.')
  }
  if (triggers.length === 0) {
    return
  }
  if (!automation.bot) {
    throw new Error('Only bot automations can start on events.')
  }
  if (triggers.length > MAX_AUTOMATION_EVENT_TRIGGERS) {
    throw new Error(`An automation can have at most ${MAX_AUTOMATION_EVENT_TRIGGERS} events.`)
  }
  const ids = new Set<string>()
  for (const trigger of triggers) {
    const kinds: readonly string[] | undefined = AUTOMATION_EVENT_KINDS[trigger.source]
    if (!kinds?.includes(trigger.event)) {
      throw new Error(`Unknown event: ${trigger.source}.${trigger.event}`)
    }
    if (!trigger.id || ids.has(trigger.id)) {
      throw new Error('Each event trigger needs its own id.')
    }
    ids.add(trigger.id)
    if (isWebhookTrigger(trigger)) {
      assertWebhookTrigger(trigger, triggers)
      continue
    }
    if (isGoogleTrigger(trigger)) {
      assertGoogleTrigger(trigger)
      continue
    }
    if (
      (trigger.in?.length ?? 0) > MAX_TRIGGER_PLACES ||
      (trigger.from?.length ?? 0) > MAX_TRIGGER_PLACES ||
      [trigger.id, ...(trigger.in ?? []), ...(trigger.from ?? [])].some(
        (id) => id.length > MAX_TRIGGER_ID_LENGTH
      ) ||
      [trigger.textContains, trigger.subject, trigger.label].some(
        (text) => (text?.length ?? 0) > MAX_TRIGGER_FILTER_LENGTH
      )
    ) {
      throw new Error(`The ${trigger.source}.${trigger.event} trigger's filters are too long.`)
    }
    assertGitHubFilters(trigger)
    assertWorkflowWait(trigger, automation)
    if (trigger.fromOwner && !takesOwnEvents(trigger)) {
      throw new Error(
        `Your own events can start only github.pr_opened, not ${trigger.source}.${trigger.event}.`
      )
    }
  }
}

// Its filters and size are checked in main, beside the one matcher (automation-webhook-rule.ts).
function assertWebhookTrigger(
  trigger: AutomationWebhookTrigger,
  triggers: readonly AutomationEventTrigger[]
): void {
  if (triggers.filter(isWebhookTrigger).length > 1) {
    throw new Error('An automation can have only one webhook.')
  }
  if (hookIdOfRule(trigger.id) === null || !Number.isInteger(trigger.rev) || trigger.rev < 1) {
    throw new Error('This webhook has not been made yet.')
  }
}

// Its deadline is its only time; a schedule would start it again after the deadline.
function assertOnceStarts(automation: Automation): void {
  if (!automation.bot) {
    throw new Error('Only bot automations can run once.')
  }
  if (hasAutomationSchedule(automation)) {
    throw new Error('A run-once automation starts on an event or at its --by time, not a schedule.')
  }
  if (!automation.on?.length && automation.once?.by === undefined) {
    throw new Error('A run-once automation needs an event (--on) or a time (--by).')
  }
  assertAutomationOnce(automation)
}
