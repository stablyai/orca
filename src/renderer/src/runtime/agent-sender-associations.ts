import type { AppState } from '@/store/types'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../../shared/agent-sender-associations'
import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import { structuredAgentSessionOwnerInputs } from './structured-agent-session-owner'
import type { Tab } from '../../../shared/tab-types'
import { agentSenderAliasParts, assembleAgentSenderAliases } from './agent-sender-alias-projection'
import {
  effectivePublications,
  type AgentSenderPublications
} from './agent-sender-publication-patch'

export { agentSenderPublicationPatch } from './agent-sender-publication-patch'
export type { AgentSenderPublications } from './agent-sender-publication-patch'
export type LocatedAgentSender = AgentSenderAssociation & { host: string; tab?: Tab }
const EMPTY: AgentSenderPublications = Object.freeze({})
const key = (host: string, address: string) => JSON.stringify([host, address])

let cache:
  | {
      inputs: unknown[]
      source: AppState['agentSenderPublicationsByHost']
      parts: readonly unknown[]
      index: Map<string, LocatedAgentSender | null>
    }
  | undefined
let builds = 0
let visits = 0
export const agentSenderIndexWorkForTest = () => ({ builds, visits })
function senderIndex(state: AppState) {
  const inputs = [
    state.agentSenderPublicationsByHost,
    state.unifiedTabsByWorktree,
    state.tabsByWorktree,
    ...structuredAgentSessionOwnerInputs(state)
  ]
  if (cache && inputs.every((input, i) => input === cache?.inputs[i])) {
    return cache
  }
  const parts = agentSenderAliasParts(state)
  if (
    cache &&
    cache.source === state.agentSenderPublicationsByHost &&
    cache.parts.length === parts.length &&
    cache.parts.every((part, i) => part === parts[i])
  ) {
    cache.inputs = inputs
    return cache
  }
  const { visible, chatTabs } = assembleAgentSenderAliases(parts)
  const unique = <T>(map: Map<string, T | null>, id: string, value: T) => {
    if (!map.has(id)) {
      map.set(id, value)
    } else if (JSON.stringify(map.get(id)) !== JSON.stringify(value)) {
      map.set(id, null)
    }
  }
  builds++
  const index = new Map<string, LocatedAgentSender | null>()
  const publications = Object.entries(state.agentSenderPublicationsByHost ?? EMPTY)
  const execution = new Map<string, { host: string; publication: AgentSenderPublication }[]>()
  for (const [host, scopes] of publications) {
    for (const publication of effectivePublications(scopes)) {
      if (publication.peerFingerprint) {
        const bucket = execution.get(publication.peerFingerprint) ?? []
        bucket.push({ host, publication })
        execution.set(publication.peerFingerprint, bucket)
      }
    }
  }
  const locate = (host: string, row: AgentSenderAssociation): LocatedAgentSender | null => {
    const actual = visible.get(key(host, row.paneKey))
    if (actual === null) {
      return null
    }
    const paneKey = actual ?? row.paneKey
    return { ...row, host, paneKey, tab: chatTabs.get(key(host, paneKey)) }
  }
  // Execution rows grouped by (execution peer, home principal that attached them).
  const attachments = new Map<string, Map<string, LocatedAgentSender | null>>()
  for (const [peer, values] of execution) {
    for (const { host, publication } of values) {
      for (const row of publication.attachments) {
        visits++
        const location = locate(host, row)
        if (location) {
          const principal = key(peer, row.homePeerFingerprint)
          const bucket = attachments.get(principal) ?? new Map()
          attachments.set(principal, bucket)
          unique(bucket, row.identity, location)
        }
      }
    }
  }
  for (const [host, scopes] of publications) {
    const values = effectivePublications(scopes)
    for (const publication of values) {
      for (const row of publication.associations) {
        visits++
        const location = locate(host, row)
        if (location) {
          unique(index, key(host, row.identity), location)
        }
      }
    }
    // Principals repeat in every scope of a host; join each peer once.
    const principals = new Set(
      values.flatMap((publication) =>
        publication.principals.map((p) => key(p.peerFingerprint, p.homePeerFingerprint))
      )
    )
    for (const principal of principals) {
      for (const [identity, location] of attachments.get(principal) ?? []) {
        visits++
        if (location) {
          unique(index, key(host, identity), location)
        } else {
          index.set(key(host, identity), null)
        }
      }
    }
  }
  const owners = new Map<string, string | null>()
  for (const row of index.values()) {
    if (!row) {
      continue
    }
    const id = key(row.worktreeId, row.paneKey)
    owners.set(id, owners.has(id) && owners.get(id) !== row.host ? null : row.host)
  }
  for (const [id, row] of index) {
    if (row && owners.get(key(row.worktreeId, row.paneKey)) === null) {
      index.set(id, null)
      continue
    }
    const previous = cache?.index.get(id)
    if (
      row &&
      previous &&
      row.host === previous.host &&
      row.paneKey === previous.paneKey &&
      row.worktreeId === previous.worktreeId &&
      row.sessionId === previous.sessionId &&
      row.tab === previous.tab
    ) {
      index.set(id, previous)
    }
  }
  cache = { inputs, source: state.agentSenderPublicationsByHost, parts, index }
  return cache
}

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
  if (!state.agentSenderPublicationsByHost?.[host]) {
    return LEGACY
  }
  const { index } = senderIndex(state)
  for (const identity of senderIdentities(sender, dispatchId)) {
    const location = index.get(key(host, identity))
    if (location === null) {
      return AMBIGUOUS
    }
    if (location) {
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
