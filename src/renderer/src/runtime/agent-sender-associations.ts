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

export function agentSenderPublicationPatch(
  state: State,
  host: string,
  scope: string,
  publication: AgentSenderPublication | undefined
): Partial<State> {
  const source = state.agentSenderPublicationsByHost ?? EMPTY
  const scopes = source[host] ?? {}
  if (scope !== '*' && scopes['*'] && publication) {
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
  if (!publication) {
    if (!source[host]) {
      return {}
    }
    const next = { ...source }
    delete next[host]
    return { agentSenderPublicationsByHost: next }
  }
  if (JSON.stringify(scopes[scope]) === JSON.stringify(publication)) {
    return {}
  }
  const next = { ...scopes, [scope]: publication }
  return { agentSenderPublicationsByHost: { ...source, [host]: next } }
}

let cache:
  | {
      inputs: unknown[]
      source: AppState['agentSenderPublicationsByHost']
      aliasesKey: string
      index: Map<string, LocatedAgentSender | null>
      hosts: Set<string>
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
  const hosts = new Set<string>()
  const publications = Object.entries(state.agentSenderPublicationsByHost ?? EMPTY)
  const execution = new Map<string, { host: string; publication: AgentSenderPublication }[]>()
  for (const [host, scopes] of publications) {
    const values = scopes['*'] ? [scopes['*']] : Object.values(scopes)
    if (values.length) {
      hosts.add(host)
    }
    for (const publication of values) {
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
  const attachments = new Map<string, LocatedAgentSender | null>()
  for (const [peer, values] of execution) {
    for (const { host, publication } of values) {
      for (const row of publication.attachments) {
        visits++
        const location = locate(host, row)
        if (location) {
          unique(attachments, key(peer, key(row.homePeerFingerprint, row.address)), location)
        }
      }
    }
  }
  for (const [host, scopes] of publications) {
    for (const publication of scopes['*'] ? [scopes['*']] : Object.values(scopes)) {
      for (const row of publication.associations) {
        visits++
        const location = locate(host, row)
        if (location) {
          unique(index, key(host, row.address), location)
        }
      }
      for (const route of publication.federation) {
        visits++
        const address = `dispatch:${route.dispatchId}`
        const location = attachments.get(
          key(route.peerFingerprint, key(route.homePeerFingerprint, address))
        )
        if (location) {
          unique(index, key(host, address), location)
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
  cache = { inputs, source: state.agentSenderPublicationsByHost, aliasesKey, index, hosts }
  return cache
}

/** Undefined publication is old-host compatibility; an authoritative miss never falls back. */
export function hasAgentSenderPublication(state: AppState, host: string): boolean {
  return senderIndex(state).hosts.has(host)
}
export function selectAgentSenderAssociation(
  state: AppState,
  host: string,
  sender: AgentMessageSender,
  dispatchId?: string
): LocatedAgentSender | undefined {
  const { index } = senderIndex(state)
  return (
    (dispatchId ? index.get(key(host, `dispatch:${dispatchId}`)) : undefined) ??
    index.get(
      key(
        host,
        sender.party.orcaSessionId
          ? `orca_session_id:${sender.party.orcaSessionId}`
          : sender.party.address
      )
    ) ??
    undefined
  )
}
