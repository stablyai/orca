import type { AppState } from '@/store/types'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../../shared/agent-sender-associations'
import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionOwnerInputs
} from './structured-agent-session-owner'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../shared/tab-types'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

export type AgentSenderPublications = Record<string, Record<string, AgentSenderPublication>>
type State = Partial<Pick<AppState, 'agentSenderPublicationsByHost'>>
export type LocatedAgentSender = AgentSenderAssociation & { host: string; tab?: Tab }
const EMPTY: AgentSenderPublications = Object.freeze({})
const key = (host: string, address: string) => JSON.stringify([host, address])

/** A host publishes once any frame carries the field; a frame without it changes only its own
 *  scope when it removes that worktree, so capability never follows which scopes have rows. */
export function agentSenderPublicationPatch(
  state: State,
  host: string,
  scope: string,
  publication: AgentSenderPublication | undefined,
  removed = false
): Partial<State> {
  const source = state.agentSenderPublicationsByHost ?? EMPTY
  const scopes = source[host]
  if (!publication) {
    // The whole-host result is the only statement that a host does not publish.
    if (scope === '*' && scopes) {
      const next = { ...source }
      delete next[host]
      return { agentSenderPublicationsByHost: next }
    }
    // A whole-host result is replaced only by the next one; a chat inventory's removal can't speak for terminals.
    if (!removed || !scopes?.[scope] || scopes['*']) {
      return {}
    }
    const next = { ...scopes }
    delete next[scope]
    return { agentSenderPublicationsByHost: { ...source, [host]: next } }
  }
  if (scope !== '*' && scopes?.['*']) {
    const previous = scopes['*']
    const current = {
      ...previous,
      associations: previous.associations.filter((row) => row.worktreeId === scope),
      attachments: previous.attachments.filter((row) => row.worktreeId === scope)
    }
    if (JSON.stringify(current) === JSON.stringify(publication)) {
      return {}
    }
    publication = {
      ...publication,
      associations: [
        ...previous.associations.filter((row) => row.worktreeId !== scope),
        ...publication.associations
      ],
      attachments: [
        ...previous.attachments.filter((row) => row.worktreeId !== scope),
        ...publication.attachments
      ]
    }
    scope = '*'
  }
  if (JSON.stringify(scopes?.[scope]) === JSON.stringify(publication)) {
    return {}
  }
  return {
    agentSenderPublicationsByHost: { ...source, [host]: { ...scopes, [scope]: publication } }
  }
}

let cache:
  | {
      inputs: unknown[]
      source: AppState['agentSenderPublicationsByHost']
      aliasesKey: string
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
  const visible = new Map<string, string | null>()
  const chatTabs = new Map<string, Tab>()
  const unique = <T>(map: Map<string, T | null>, id: string, value: T) => {
    if (!map.has(id)) {
      map.set(id, value)
    } else if (JSON.stringify(map.get(id)) !== JSON.stringify(value)) {
      map.set(id, null)
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      const host = structuredAgentSessionOwnerForTab(state, tab)
      if (host && tab.contentType === 'agent-session') {
        chatTabs.set(key(host, structuredAgentSessionPaneKey(tab.id, tab.entityId)), tab)
        unique(
          visible,
          key(
            host,
            structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.entityId), tab.entityId)
          ),
          structuredAgentSessionPaneKey(tab.id, tab.entityId)
        )
      }
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const remote = tab.ptyId ? parseRemoteRuntimePtyId(tab.ptyId) : null
      const host = remote
        ? `runtime:${remote.environmentId}`
        : getKnownExecutionHostIdForWorktree(state, worktreeId)
      if (!host) {
        continue
      }
      const [hostTab, leafId] = toHostSessionTabId(tab.id).split('::')
      if (hostTab && leafId) {
        unique(visible, key(host, `${hostTab}:${leafId}`), `${tab.id}:${leafId}`)
      }
    }
  }
  const aliasesKey = JSON.stringify([
    [...visible],
    [...chatTabs].map(([id, tab]) => [id, tab.label, tab.customLabel, tab.agentSessionAgent])
  ])
  if (
    cache &&
    cache.source === state.agentSenderPublicationsByHost &&
    cache.aliasesKey === aliasesKey
  ) {
    cache.inputs = inputs
    return cache
  }
  builds++
  const index = new Map<string, LocatedAgentSender | null>()
  const publications = Object.entries(state.agentSenderPublicationsByHost ?? EMPTY)
  const execution = new Map<string, { host: string; publication: AgentSenderPublication }[]>()
  for (const [host, scopes] of publications) {
    for (const publication of scopes['*'] ? [scopes['*']] : Object.values(scopes)) {
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
    const values = scopes['*'] ? [scopes['*']] : Object.values(scopes)
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
  cache = { inputs, source: state.agentSenderPublicationsByHost, aliasesKey, index }
  return cache
}

/** What a card's sender is on its host now; avatar, label and click all read this one answer. */
export type AgentSenderResolution =
  | { kind: 'located'; location: LocatedAgentSender }
  /** Two hosts or rows claim it: no live link, and never a guess between them. */
  | { kind: 'ambiguous' }
  /** Its identity is known but runs nowhere visible; a chat can still be reopened by its session. */
  | { kind: 'gone'; chat: boolean }
  /** A card saved without an identity the host can prove (written before sender records). */
  | { kind: 'unproved' }
  /** The host publishes nothing: an older Orca, read through its own lookup. */
  | { kind: 'legacy' }

/** Switch point for unproved senders' clicks (product decision): 'unavailable' says the agent is no
 *  longer available; 'legacy-lookup' asks the host's old lookup, which may find a replacement. */
export const UNPROVED_SENDER_CLICK: 'unavailable' | 'legacy-lookup' = 'unavailable'

const AMBIGUOUS: AgentSenderResolution = Object.freeze({ kind: 'ambiguous' })
const UNPROVED: AgentSenderResolution = Object.freeze({ kind: 'unproved' })
const LEGACY: AgentSenderResolution = Object.freeze({ kind: 'legacy' })

/** The identities a card names its sender by, most specific first: the Dispatch a Started-worker
 *  card records, the identity saved when Orca accepted the event, the chat session, a federated
 *  Dispatch address. A terminal handle alone is never one: handles outlive their agents. */
function senderIdentities(sender: AgentMessageSender, dispatchId: string | undefined): string[] {
  const { address, orcaSessionId } = sender.party
  return [
    dispatchId ? `dispatch:${dispatchId}` : undefined,
    sender.identity,
    orcaSessionId ? `orca_session_id:${orcaSessionId}` : undefined,
    address.startsWith('dispatch:') ? address : undefined
  ].filter((identity): identity is string => Boolean(identity))
}

/** Undefined publication is old-host compatibility; an authoritative miss never falls back. */
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
  const identities = senderIdentities(sender, dispatchId)
  for (const identity of identities) {
    const location = index.get(key(host, identity))
    if (location === null) {
      return AMBIGUOUS
    }
    if (location) {
      return { kind: 'located', location }
    }
  }
  return identities.length === 0
    ? UNPROVED
    : { kind: 'gone', chat: Boolean(sender.party.orcaSessionId) }
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
