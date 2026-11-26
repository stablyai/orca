// How an edit changes a bot automation's target and schedule; the desktop and the phone editors share it.
import type {
  Automation,
  AutomationBotResultsTo,
  AutomationBotTarget,
  AutomationUpdateInput
} from './automation-definition'
import {
  EVENT_ONLY_SCHEDULE,
  hasAutomationSchedule,
  isConnectorSource,
  type AutomationEventSource
} from '../automation-event-triggers'
import { sameBotAgentSetup } from '../bots/bot-agent-setup'
import { botResultsPlace } from '../automation-bot-target'

type PostedResultsTo = Extract<AutomationBotResultsTo, object>

/** The same kind of post, to `place`; the host looks a typed name or link up again on save. */
export function withBotResultsPlace(resultsTo: PostedResultsTo, place: string): PostedResultsTo {
  if (place === botResultsPlace(resultsTo)) {
    return resultsTo
  }
  return 'channel' in resultsTo ? { channel: place } : { linearIssue: place }
}

export type BotResultsToChoice = 'chat' | 'thread' | 'channel' | 'linear' | 'none'

export function botResultsToChoice(resultsTo: AutomationBotResultsTo): BotResultsToChoice {
  if (typeof resultsTo !== 'object') {
    return resultsTo
  }
  return 'channel' in resultsTo ? 'channel' : 'linear'
}

export function botResultsToOf(choice: BotResultsToChoice): AutomationBotResultsTo {
  switch (choice) {
    case 'channel':
      return { channel: '' }
    case 'linear':
      return { linearIssue: '' }
    case 'chat':
    case 'thread':
    case 'none':
      return choice
  }
}

/** Events alone start it, and each has a thread to answer in (no webhook, Gmail or Calendar), as
 *  the host's check for results to the event's thread asks. */
export function botEventsHaveThreads(
  eventsOnly: boolean,
  triggers: readonly { source: AutomationEventSource }[]
): boolean {
  return (
    eventsOnly &&
    triggers.length > 0 &&
    triggers.every((trigger) => isConnectorSource(trigger.source))
  )
}

/** The place a channel or Linear result still needs before it can be saved, or null. */
export function missingBotResultsPlace(
  target: Pick<AutomationBotTarget, 'resultsTo'>
): 'channel' | 'linear' | null {
  const { resultsTo } = target
  if (typeof resultsTo !== 'object') {
    return null
  }
  // A key, a link or a saved ref; the host looks it up on save.
  if ('channel' in resultsTo) {
    return resultsTo.channel.trim() ? null : 'channel'
  }
  return resultsTo.linearIssue.trim() ? null : 'linear'
}

/** The target as saved: a typed channel or issue loses its surrounding spaces. */
export function trimmedBotTarget(target: AutomationBotTarget): AutomationBotTarget {
  return typeof target.resultsTo === 'object'
    ? {
        ...target,
        resultsTo: withBotResultsPlace(target.resultsTo, botResultsPlace(target.resultsTo).trim())
      }
    : target
}

function resultsKey(target: AutomationBotTarget): string {
  const { resultsTo } = target
  if (typeof resultsTo !== 'object') {
    return resultsTo
  }
  return 'channel' in resultsTo ? `channel:${resultsTo.channel}` : `linear:${resultsTo.linearIssue}`
}

/** Unchanged targets are left out of an edit. */
export function isSameBotTarget(
  left: AutomationBotTarget | undefined,
  right: AutomationBotTarget
): boolean {
  return (
    left !== undefined &&
    left.botId === right.botId &&
    left.runsIn === right.runsIn &&
    left.chat?.sessionId === right.chat?.sessionId &&
    resultsKey(left) === resultsKey(right) &&
    Boolean(left.letBotReact) === Boolean(right.letBotReact) &&
    sameBotAgentSetup(left.agentSetup, right.agentSetup)
  )
}

/** The schedule fields an edit sends: none while unchanged, the never-reached one for "Only on events". */
export function botSchedulePatch(
  eventsOnly: boolean,
  current: Pick<Automation, 'dtstart' | 'rrule'> | null,
  schedule: { rrule: string; dtstart: number }
): Partial<Pick<AutomationUpdateInput, 'rrule' | 'dtstart'>> {
  const scheduled = current === null || hasAutomationSchedule(current)
  if (eventsOnly) {
    return scheduled ? { ...EVENT_ONLY_SCHEDULE } : {}
  }
  // A picked schedule is new even when its rule matches the never-reached one.
  return !scheduled || current?.rrule !== schedule.rrule ? schedule : {}
}
