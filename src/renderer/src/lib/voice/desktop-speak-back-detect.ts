import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** The decision half of desktop speak-back, kept pure so the working→done edge,
 *  the dedupe key, and the state filter are all testable without audio, a store
 *  or a clock. */

export type SpeakBackAnnouncement = {
  paneKey: string
  reply: string
  /** Dedupe key: paneKey + a prefix of the reply. paneKey alone would suppress
   *  the pane's NEXT real turn; the reply prefix lets a genuinely new answer
   *  through while a repeated poll of the same 'done' row stays silent. */
  dedupeKey: string
}

/**
 * Decide whether an agent row that just changed should be spoken.
 *
 * `wasWorking` is the caller's memory of this pane's previous state. We speak
 * only on a working→done EDGE, never on a 'done' row we merely re-observed —
 * and only 'done', not any non-working state: 'waiting' means the agent is
 * asking the operator something and 'blocked' means it is stuck, neither of
 * which carries a finished reply (measured 2026-07-21: a 'waiting' transition
 * reports lastAssistantMessage null).
 */
export function detectSpeakBackAnnouncement(
  entry: Pick<AgentStatusEntry, 'paneKey' | 'state' | 'lastAssistantMessage'>,
  wasWorking: boolean
): SpeakBackAnnouncement | null {
  if (!wasWorking || entry.state !== 'done') {
    return null
  }
  const reply = entry.lastAssistantMessage?.trim()
  if (!reply) {
    return null
  }
  return {
    paneKey: entry.paneKey,
    reply,
    dedupeKey: `${entry.paneKey}:${reply.slice(0, 120)}`
  }
}
