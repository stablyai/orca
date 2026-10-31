import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionLatestTurn } from './agent-session-wire'
import { readAgentJournalTurn } from './agent-session-turn-record'
import type { NativeChatRole } from './native-chat-types'
import { isStructuredAgentSessionCommandTurn } from './structured-agent-session-command-entry'
import { runningStructuredAgentSessionTurnScope } from './structured-agent-session-live-turn'
import { structuredAgentSessionOpeningSendIn } from './structured-agent-session-opening-send'

/** Place pending sends after live activity when host handover waits: during conversation commands (/compact), Stop, or a send still opening its turn.
 * Include this client’s unrecorded sends; ordinary running turns accept sends promptly, and pre-Stop sends stay put.
 * While a turn opens, later sends wait regardless of queue/publication state; queued positions precede the handover that moved the opening send. */
export function nativeChatMessagesWaitingBehindLiveTurn(
  messages: readonly {
    id: string
    role?: NativeChatRole
    queued?: true
    unsent?: true
    sentWhileStopping?: true
    awaitsRetry?: true
    journalPosition?: unknown
  }[],
  items: readonly AgentJournalRenderItem[] | null | undefined,
  stopping = false,
  submissions?: readonly AgentJournalSubmission[],
  /** Host current-work view excludes ended generations’ stale turns/sends. Older hosts omit it; fall back to rows. */
  host: { latestTurn?: AgentSessionLatestTurn | null; working?: boolean } = {}
): ReadonlySet<string> {
  const waits = (message: (typeof messages)[number]): boolean =>
    message.queued === true || (stopping && message.sentWhileStopping === true)
  // Behind a turn still opening: queued, or a send of this client's the host has not recorded and
  // is not waiting on the user's Retry.
  const unrecorded = (message: (typeof messages)[number]): boolean =>
    message.role === 'user' &&
    message.journalPosition === undefined &&
    message.unsent !== true &&
    message.awaitsRetry !== true
  const candidates = messages.filter((message) => waits(message) || unrecorded(message))
  if (candidates.length === 0 || !items) {
    return new Set()
  }
  const behindHold = stopping || commandTurnRunning(items, host.latestTurn)
  const behindOpening =
    host.working !== false &&
    submissions !== undefined &&
    structuredAgentSessionOpeningSendIn(items, submissions) !== null
  return new Set(
    candidates
      .filter(
        (message) =>
          (behindHold && waits(message)) ||
          (behindOpening && (message.queued === true || unrecorded(message)))
      )
      .map((message) => message.id)
  )
}

function commandTurnRunning(
  items: readonly AgentJournalRenderItem[],
  latestTurn: AgentSessionLatestTurn | null | undefined
): boolean {
  const running = runningStructuredAgentSessionTurnScope({
    items,
    ...(latestTurn !== undefined ? { latestTurn } : {})
  })
  const bodyOf = (itemId: string) => items.find((item) => item.itemId === itemId)?.body
  return (
    running.kind === 'turn' &&
    isStructuredAgentSessionCommandTurn(readAgentJournalTurn(bodyOf(running.turnItemId)), bodyOf)
  )
}

/** An opening send owns the live turn; later waiting messages cannot replace its key. */
export function nativeChatOpeningTurnKey(
  messages: readonly { id: string }[],
  turnKeys: readonly (string | undefined)[],
  journal: {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  }
): string | undefined {
  const opening = structuredAgentSessionOpeningSendIn(journal.items, journal.submissions)
  const index = opening === null ? -1 : messages.findIndex((message) => message.id === opening)
  return index === -1 ? undefined : turnKeys[index]
}
