// Where a bot automation's final message goes, in words: `automations show` and the run's prompt
// say the same place.
import {
  botResultsPlace,
  type AutomationBotTarget,
  type AutomationOriginThread
} from '../automation-bot-target'
import { CONNECTOR_SOURCE_NAMES } from '../connectors/external-conversation-link'

type AutomationResultsPlace =
  /** A reply under a thread: the one the automation was made in, or each event's. */
  | { kind: 'thread'; where: string }
  /** A new top-level post in a channel. */
  | { kind: 'post'; where: string }
  | { kind: 'comment'; where: string }
  /** Kept in Orca: the chat the run continues, or the bot's Chat. */
  | { kind: 'orca'; where: 'run-chat' | 'bot-chat' }
  | { kind: 'none' }

type ResultsTarget = Pick<AutomationBotTarget, 'runsIn' | 'chat' | 'resultsTo' | 'originThread'>

/** "the Slack thread in #orca", or the thread it was made in when Orca never learned its name. */
export function originThreadText(thread: AutomationOriginThread | undefined): string {
  const source = thread ? CONNECTOR_SOURCE_NAMES[thread.source] : 'Slack'
  return thread?.place
    ? `the ${source} thread in ${thread.place}`
    : `the ${source} thread it was made in`
}

/** Every place a run's final message goes, the thread first: a run in a chat that answers a thread
 *  answers there, and a channel or issue named besides gets a copy. */
function automationResultsPlaces(target: ResultsTarget): AutomationResultsPlace[] {
  const inThread = target.runsIn === 'chat' && target.chat?.toConversation === true
  const thread: AutomationResultsPlace[] = inThread
    ? [{ kind: 'thread', where: originThreadText(target.originThread) }]
    : []
  const { resultsTo } = target
  if (typeof resultsTo === 'object') {
    const where = botResultsPlace(resultsTo)
    return [
      ...thread,
      'channel' in resultsTo ? { kind: 'post', where } : { kind: 'comment', where }
    ]
  }
  if (thread.length > 0) {
    return thread
  }
  if (resultsTo === 'thread') {
    return [{ kind: 'thread', where: "the event's thread or issue" }]
  }
  if (resultsTo === 'none') {
    return [{ kind: 'none' }]
  }
  return [
    { kind: 'orca', where: target.runsIn === 'chat' && target.chat ? 'run-chat' : 'bot-chat' }
  ]
}

const CLI_PLACE = {
  thread: (where: string) => `${where} (a reply in the thread)`,
  post: (where: string) => `${where} (a new top-level post)`,
  comment: (where: string) => `${where} (a comment)`
}

/** `results to: ...` as `automations show` prints it. */
export function formatAutomationResultsTo(target: ResultsTarget): string {
  const places = automationResultsPlaces(target).map((place) => {
    switch (place.kind) {
      case 'orca':
        return place.where === 'run-chat'
          ? 'the chat it runs in (stays in Orca)'
          : "the bot's Chat (stays in Orca)"
      case 'none':
        return "nowhere (it stays in the run's conversation in Orca)"
      case 'thread':
      case 'post':
      case 'comment':
        return CLI_PLACE[place.kind](place.where)
    }
  })
  return `results to: ${places.join(', and ')}`
}

/** What a run's prompt says of its final message, to the bot reading it. Run by hand, an event's
 *  thread run is in no thread, so its result stays in its conversation. */
export function automationResultsSentence(
  target: ResultsTarget,
  trigger: 'scheduled' | 'manual' | 'event'
): string {
  const routed =
    target.resultsTo === 'thread' && trigger === 'manual'
      ? { ...target, resultsTo: 'none' as const }
      : target
  const places = automationResultsPlaces(routed).map((place) => {
    switch (place.kind) {
      case 'thread':
        return `posts as a reply in ${place.where}`
      case 'post':
        return `posts as a new top-level post in ${place.where}`
      case 'comment':
        return `posts as a comment on ${place.where}`
      case 'orca':
        return place.where === 'run-chat'
          ? 'stays in Orca, in this chat'
          : 'stays in Orca: it goes to your Chat'
      case 'none':
        return 'stays in Orca, in this conversation: nothing posts it anywhere'
    }
  })
  return `Your final message ${places.join(', and a copy ')}.`
}
