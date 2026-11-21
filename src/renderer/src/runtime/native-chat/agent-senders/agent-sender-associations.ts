import type { AppState } from '@/store/types'
import type { AgentMessageSender } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { readAgentSender, type LocatedAgentSender } from './agent-sender-index'

/** Where a card's sender runs on its host now, before the saved-kind check the card layer adds. */
export type AgentSenderResolution =
  | { kind: 'located'; location: LocatedAgentSender }
  /** Two hosts or rows claim it: no live link, and never a guess between them. */
  | { kind: 'ambiguous' }
  /** The host runs nothing under the identities the card saved: a closed chat, a terminal that
   *  exited or was respawned, or a sender with no identity this host can name. */
  | { kind: 'gone'; sender: 'chat' | 'terminal' | 'other' }
  /** The host publishes nothing: an older Orca, read through its own lookup. */
  | { kind: 'legacy' }

const AMBIGUOUS: AgentSenderResolution = Object.freeze({ kind: 'ambiguous' })
const LEGACY: AgentSenderResolution = Object.freeze({ kind: 'legacy' })

/** The identities a card names its sender by, most specific first: the Dispatch a Started-worker
 *  card records, the chat session, the terminal handle it sent from, a federated Dispatch. */
function senderIdentities(sender: AgentMessageSender, dispatchId: string | undefined): string[] {
  const { address, orcaSessionId, terminalHandle } = sender.party
  return [
    dispatchId ? `dispatch:${dispatchId}` : undefined,
    orcaSessionId ? `orca_session_id:${orcaSessionId}` : undefined,
    terminalHandle && !terminalHandle.startsWith('dispatch:') ? terminalHandle : undefined,
    address.startsWith('dispatch:') ? address : undefined
  ].filter((identity): identity is string => Boolean(identity))
}

/** Undefined publication is old-host compatibility; the first identity the host proves selects
 *  the one target, and an ambiguous one never falls through to another. */
export function resolveAgentMessageSender(
  state: AppState,
  host: string,
  sender: AgentMessageSender,
  dispatchId?: string
): AgentSenderResolution {
  if (
    sender.party.address.startsWith('run:') &&
    !sender.party.orcaSessionId &&
    !sender.party.terminalHandle
  ) {
    return { kind: 'gone', sender: 'other' }
  }
  if (!state.agentSenderPublicationsByHost?.[host]) {
    return LEGACY
  }
  for (const identity of senderIdentities(sender, dispatchId)) {
    const location = readAgentSender(state, host, identity)
    if (location === null) {
      return AMBIGUOUS
    }
    if (location) {
      const role = sender.party.address.startsWith('dispatch:') || dispatchId !== undefined
      const stableSession = identity.startsWith('orca_session_id:')
      if (
        (identity.startsWith('dispatch:') || (role && !stableSession)) &&
        location.dispatchActor !== true
      ) {
        continue
      }
      return { kind: 'located', location }
    }
  }
  const { orcaSessionId, terminalHandle } = sender.party
  return {
    kind: 'gone',
    sender: orcaSessionId
      ? 'chat'
      : terminalHandle && !terminalHandle.startsWith('dispatch:')
        ? 'terminal'
        : 'other'
  }
}

/** Undefined publication is old-host compatibility; an authoritative miss never falls back. */
export function hasAgentSenderPublication(state: AppState, host: string): boolean {
  return Boolean(state.agentSenderPublicationsByHost?.[host])
}
export function selectAgentSenderAssociation(
  state: AppState,
  host: string,
  sender: AgentMessageSender,
  dispatchId?: string
): LocatedAgentSender | undefined {
  const resolution = resolveAgentMessageSender(state, host, sender, dispatchId)
  return resolution.kind === 'located' ? resolution.location : undefined
}
