// What an automation run's row says, from Orca's own record of the run. The desktop translates each
// phrase by its key; the phone reads the English.
import type { AutomationRunMessage, AutomationRunMessageEvent } from './automation-run-message'
import {
  AUTOMATION_RUN_COPY,
  type AutomationRunCopyKey,
  type SayAutomationRun
} from './automation-run-row-copy'

export {
  AUTOMATION_RUN_COPY,
  sayAutomationRunEnglish,
  type AutomationRunCopyKey,
  type SayAutomationRun
} from './automation-run-row-copy'
/** A row's state: it ran, waits behind the chat's turn, or no chat took it. */
export type AutomationRunRowState = 'ran' | 'queued' | 'not-started'

/** On a run that couldn't start: Send again is offered, already went, or isn't for this chat. */
export type AutomationRunResend = 'offer' | 'sent' | 'none'

const SOURCE_LABELS = {
  github: 'github',
  slack: 'slack',
  linear: 'linear',
  webhook: 'webhook',
  gmail: 'gmail',
  calendar: 'calendar'
} as const satisfies Record<AutomationRunMessageEvent['source'], AutomationRunCopyKey>

/** What fired: Wait over, Scheduled, Run now, or the event's source. */
export function automationRunLabel(run: AutomationRunMessage, say: SayAutomationRun): string {
  if (run.wait) {
    return say('waitOver')
  }
  if (run.trigger === 'manual') {
    return say('runNow')
  }
  if (run.trigger === 'scheduled' || !run.event) {
    return say('scheduled')
  }
  return say(SOURCE_LABELS[run.event.source] ?? 'what.other')
}

function whatKey(event: AutomationRunMessageEvent): string {
  return `what.${event.source}.${event.event}`
}

// Things done to a thread or pull request read "Comment on #41812"; states read "CI passed · #41979".
const DONE_ON = new Set([
  'what.github.comment',
  'what.github.review_comment',
  'what.github.review',
  'what.github.mentioned',
  'what.github.pr_pushed',
  'what.github.review_requested',
  'what.linear.mentioned'
])

function isCopyKey(key: string): key is AutomationRunCopyKey {
  return Object.hasOwn(AUTOMATION_RUN_COPY, key)
}

function eventWhat(event: AutomationRunMessageEvent, say: SayAutomationRun): string {
  const key = whatKey(event)
  return say(isCopyKey(key) ? key : 'what.other')
}

/** "#41812" from "stablyai/orca#41812"; any other place as it is. */
function shortPlace(place: string): string {
  return /#\d+$/.exec(place)?.[0] ?? place
}

function eventPhrase(
  event: AutomationRunMessageEvent,
  where: string | undefined,
  say: SayAutomationRun,
  joined: 'reason' | 'facts'
): string {
  if (event.source === 'webhook') {
    return say(event.webhook?.sample ? 'sampleCall' : 'webhookCall')
  }
  const what = eventWhat(event, say)
  if (!where) {
    return what
  }
  if (event.source === 'slack') {
    return say('whatIn', { what, where })
  }
  return say(joined === 'facts' || DONE_ON.has(whatKey(event)) ? 'whatOn' : 'whatAt', {
    what,
    where
  })
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase() + text.slice(1)
}

// A schedule more than a minute late (the computer slept) says when it was due.
const LATE_MS = 60_000

function ranLate(
  run: AutomationRunMessage,
  ranAt: number | null
): run is AutomationRunMessage & {
  scheduledFor: number
} {
  return run.scheduledFor !== undefined && ranAt !== null && ranAt - run.scheduledFor > LATE_MS
}

/** How a platform words a run: phrases, times, and the automation's schedule ("Daily 8:30 AM"). */
export type AutomationRunWording = {
  say: SayAutomationRun
  formatTime: (at: number) => string
  schedule: string
}

/** Why it ran, in a few words; its own slot, so it survives when the name truncates. */
export function automationRunReason(
  run: AutomationRunMessage,
  state: AutomationRunRowState,
  ranAt: number | null,
  { say, formatTime, schedule }: AutomationRunWording
): string {
  if (state === 'not-started') {
    return say('couldNotStart')
  }
  if (state === 'queued') {
    return say('queued')
  }
  if (run.wait?.kind === 'deadline') {
    return say('deadlineReached')
  }
  if (run.event) {
    const phrase = eventPhrase(
      run.event,
      run.event.place && shortPlace(run.event.place),
      say,
      'reason'
    )
    return run.event.replayed ? say('reused', { what: lowerFirst(phrase) }) : phrase
  }
  return ranLate(run, ranAt) ? say('due', { time: formatTime(run.scheduledFor) }) : schedule
}

/** Orca's own line about what happened, where and when. */
export function automationRunFacts(
  run: AutomationRunMessage,
  ranAt: number | null,
  { say, formatTime, schedule }: AutomationRunWording
): string {
  const { event } = run
  if (event) {
    const phrase = eventPhrase(event, event.place, say, 'facts')
    const time = formatTime(event.occurredAt)
    return event.replayed
      ? say('reusedFrom', { what: lowerFirst(phrase), time })
      : say('factsAt', { facts: phrase, time })
  }
  if (run.wait?.kind === 'deadline') {
    return say('factsAt', { facts: say('deadlineReached'), time: formatTime(run.wait.at) })
  }
  if (ranLate(run, ranAt)) {
    const late = say('dueRan', { due: formatTime(run.scheduledFor), ran: formatTime(ranAt!) })
    return schedule ? say('factsAt', { facts: schedule, time: late }) : late
  }
  return schedule
}

/** Its link, only to an https page of the event's own service. */
export function automationRunEventLink(
  event: AutomationRunMessageEvent,
  say: SayAutomationRun
): { url: string; label: string } | null {
  if (!event.url) {
    return null
  }
  let url: URL
  try {
    url = new URL(event.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return null
  }
  const label =
    event.source === 'github'
      ? say('openOnGitHub')
      : event.source === 'slack'
        ? say('openInSlack')
        : event.source === 'linear'
          ? say('openInLinear')
          : say('openLink')
  return { url: url.toString(), label }
}

/** Who wrote the quoted text: the person, the caller of a webhook, or someone Orca can't name. */
export function automationRunQuoteAuthor(
  event: AutomationRunMessageEvent,
  say: SayAutomationRun
): string {
  if (event.source === 'webhook') {
    return say('callerSent')
  }
  return event.actor ? say('personWrote', { name: event.actor }) : say('someoneWrote')
}

/** Their access as Orca recorded it when the run was delivered; nothing where it wasn't asked. */
export function automationRunAccess(
  event: AutomationRunMessageEvent,
  say: SayAutomationRun
): string | null {
  switch (event.asker) {
    case 'member':
      return event.actor ? say('memberAccess', { name: event.actor }) : say('someMemberAccess')
    case 'other':
      return say('otherAccess')
    case 'owner':
      return say('ownerAccess')
    case undefined:
      return null
  }
}

/** Facts, then the provenance line, the author and the quote, so the attribution travels with it. */
export function automationRunEventCopyText(
  facts: string,
  event: AutomationRunMessageEvent,
  say: SayAutomationRun
): string {
  if (!event.text) {
    return facts
  }
  const access = automationRunAccess(event, say)
  return [
    facts,
    say('external'),
    `${automationRunQuoteAuthor(event, say)}:`,
    event.text,
    ...(event.textShortened ? [say('shortened')] : []),
    ...(access ? [access] : [])
  ].join('\n')
}

/** The row's accessible name, built for the run rather than a heading. */
export function automationRunAccessibleName(
  input: { label: string; name: string; reason: string; time: string | null },
  say: SayAutomationRun
): string {
  const { label, name, reason, time } = input
  if (reason) {
    return time
      ? say('accessibleNameAt', { label, name, reason, time })
      : say('accessibleName', { label, name, reason })
  }
  return time
    ? say('accessibleNameNoReasonAt', { label, name, time })
    : say('accessibleNameNoReason', { label, name })
}
