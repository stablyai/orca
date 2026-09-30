// Whether an outbox send asks the host to hold it as a draft (`delivery: 'queue-if-active'`).
//
// The one stored fact is `sentDelivery`, what the first attempt put on the wire. An attempted id
// replays it, for fingerprint parity with what the host may have recorded; a never-attempted one
// decides at attempt time. Nothing here ever holds a send: an unknown capability sends plain, as a
// host without queueing always has.

import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** What the connected host says about queued messages; `unknown` until it has answered, and after
 *  a failed probe. */
export type StructuredAgentSessionQueueCapability = 'unknown' | 'supported' | 'unsupported'

/** `enabled` is the user's setting. */
export type StructuredAgentSessionQueueDelivery = {
  capability: StructuredAgentSessionQueueCapability
  enabled: boolean
}

/** Whether this entry's next request asks to be queued. An attempted id asks exactly what it sent,
 *  except of a host known not to queue, which rejects the field before its operation ledger, so
 *  nothing there was recorded with it. A first attempt asks only of a host known to queue, with
 *  the setting on, for plain text that is not a launch prompt. */
export function structuredAgentSessionEntryAsksToQueue(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): boolean {
  if (entry.lastAttemptAt !== null) {
    return entry.sentDelivery === 'queue-if-active' && host.capability !== 'unsupported'
  }
  return (
    host.capability === 'supported' &&
    host.enabled &&
    entry.source !== 'launch' &&
    entry.body.blocks.every((block) => block.type === 'text')
  )
}

/** The next attempt: `stored` is what the entry keeps (a first attempt records what it sent; the
 *  capability never rewrites that), `wire` the request's own copy, carrying what it sends. */
export function structuredAgentSessionEntryAttempt(
  entry: StructuredAgentSessionOutboxEntry,
  host: StructuredAgentSessionQueueDelivery
): { stored: StructuredAgentSessionOutboxEntry; wire: StructuredAgentSessionOutboxEntry } {
  const sentDelivery: StructuredAgentSessionOutboxEntry['sentDelivery'] =
    structuredAgentSessionEntryAsksToQueue(entry, host) ? 'queue-if-active' : null
  const stored = entry.lastAttemptAt !== null ? entry : { ...entry, sentDelivery }
  return {
    stored,
    wire: stored.sentDelivery === sentDelivery ? stored : { ...stored, sentDelivery }
  }
}

/** The queue fields a stored entry carries, read back from storage. */
export function parseStructuredAgentSessionOutboxQueueFields(entry: {
  sentDelivery?: unknown
  outlivedStop?: unknown
}): Pick<StructuredAgentSessionOutboxEntry, 'sentDelivery' | 'outlivedStop'> {
  return {
    ...(entry.sentDelivery === 'queue-if-active' || entry.sentDelivery === null
      ? { sentDelivery: entry.sentDelivery }
      : {}),
    ...(entry.outlivedStop === true ? { outlivedStop: true as const } : {})
  }
}
