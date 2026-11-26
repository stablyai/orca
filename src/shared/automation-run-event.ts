import type {
  AutomationConnectorEventTrigger,
  AutomationEventSource,
  AutomationEventTrigger
} from './automation-event-triggers'

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
