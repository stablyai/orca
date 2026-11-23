import type { AppState } from '@/store/types'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import { structuredAgentSessionOwnerInputs } from '../session-ownership/structured-agent-session-owner'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { agentSenderAliasParts, assembleAgentSenderAliases } from './agent-sender-alias-projection'
import {
  HostPartDraft,
  merge,
  wholeHostRowsFor,
  type HostPart,
  type LocatedRows as BaseLocatedRows
} from './agent-sender-host-part'

/** `paneKey` is this window's name for the pane; `hostPaneKey` is the name its host gave it. */
export type LocatedAgentSender = AgentSenderAssociation & {
  host: string
  hostPaneKey: string
  tab?: Tab
}
const key = (host: string, address: string) => JSON.stringify([host, address])
type Aliases = ReturnType<typeof assembleAgentSenderAliases>
type Located = LocatedAgentSender | null
type SenderIndex = {
  parts: ReadonlyMap<string, HostPart>
  results: Map<string, Located | undefined>
  /** Whether another host claims a pane, by pane and claiming host. */
  rivals: Map<string, boolean>
}
type LocatedRows = BaseLocatedRows & {
  aliases: Aliases
  host: string
}

const EMPTY: AppState['agentSenderPublicationsByHost'] = Object.freeze({})
let aliasCache: { inputs: unknown[]; parts: readonly unknown[]; aliases: Aliases } | undefined
const locatedRows = new WeakMap<AgentSenderPublication, LocatedRows>()
type BuiltPart = {
  aliases: Aliases
  host: string
  scopes: Record<string, AgentSenderPublication>
  part: HostPart
}
const hostParts = new WeakMap<object, BuiltPart>()
/** Each host's newest part: the base a later scope change edits instead of rebuilding. */
const latestParts = new Map<string, BuiltPart>()
const indexes = new WeakMap<object, { aliases: Aliases; index: SenderIndex }>()
let joins = 0

function senderAliases(state: AppState): Aliases {
  const inputs = [
    state.unifiedTabsByWorktree,
    state.tabsByWorktree,
    ...structuredAgentSessionOwnerInputs(state)
  ]
  if (aliasCache?.inputs.every((input, i) => input === inputs[i])) {
    return aliasCache.aliases
  }
  const parts = agentSenderAliasParts(state)
  if (
    aliasCache?.parts.length === parts.length &&
    aliasCache.parts.every((part, i) => part === parts[i])
  ) {
    aliasCache.inputs = inputs
    return aliasCache.aliases
  }
  aliasCache = { inputs, parts, aliases: assembleAgentSenderAliases(parts) }
  return aliasCache.aliases
}

function locate(publication: AgentSenderPublication, host: string, aliases: Aliases): LocatedRows {
  const cached = locatedRows.get(publication)
  if (cached?.aliases === aliases && cached.host === host) {
    return cached
  }
  const place = (row: AgentSenderAssociation): LocatedAgentSender[] => {
    joins++
    const actual = aliases.windowPane(host, row.paneKey)
    const paneKey = actual ?? row.paneKey
    const tab = aliases.chatTabs.get(key(host, paneKey))
    return actual === null ? [] : [{ ...row, host, paneKey, hostPaneKey: row.paneKey, tab }]
  }
  const peer = publication.peerFingerprint
  const rows: LocatedRows = {
    aliases,
    host,
    associations: publication.associations.flatMap(place),
    attachments: peer
      ? publication.attachments.flatMap((row) =>
          place(row).map((location) => [key(peer, row.homePeerFingerprint), location] as const)
        )
      : []
  }
  locatedRows.set(publication, rows)
  return rows
}

/** The whole-host publication is the baseline; each newer scope replaces its worktree's rows.
 *  A change to scopes alone edits the host's previous part: the replaced scopes leave, and the
 *  baseline rows of worktrees that gained or lost a scope swap in or out. */
function hostPart(
  host: string,
  scopes: Record<string, AgentSenderPublication>,
  aliases: Aliases
): HostPart {
  const cached = hostParts.get(scopes)
  if (cached?.aliases === aliases && cached.host === host) {
    return cached.part
  }
  const previous = latestParts.get(host)
  const whole = scopes['*']
  const part =
    previous?.aliases === aliases && previous.scopes['*'] === whole
      ? editedHostPart(host, previous, scopes, aliases)
      : builtHostPart(host, scopes, aliases)
  const built = { aliases, host, scopes, part }
  hostParts.set(scopes, built)
  latestParts.set(host, built)
  return part
}

function builtHostPart(
  host: string,
  scopes: Record<string, AgentSenderPublication>,
  aliases: Aliases
): HostPart {
  const draft = new HostPartDraft(undefined, () => joins++)
  const whole = scopes['*']
  if (whole) {
    draft.rows(locate(whole, host, aliases), 1, (row) => !Object.hasOwn(scopes, row.worktreeId))
    draft.publicationPrincipals(whole, 1)
  }
  for (const [id, publication] of Object.entries(scopes)) {
    if (id !== '*') {
      draft.rows(locate(publication, host, aliases), 1)
      draft.publicationPrincipals(publication, 1)
    }
  }
  return draft.finish()
}

function editedHostPart(
  host: string,
  previous: BuiltPart,
  scopes: Record<string, AgentSenderPublication>,
  aliases: Aliases
): HostPart {
  const draft = new HostPartDraft(previous.part, () => joins++)
  const whole = scopes['*']
  const wholeRows = whole && locate(whole, host, aliases)
  const ids = new Set([...Object.keys(previous.scopes), ...Object.keys(scopes)])
  ids.delete('*')
  for (const id of ids) {
    const before = previous.scopes[id]
    const after = scopes[id]
    if (before === after) {
      continue
    }
    if (before) {
      draft.rows(locate(before, host, aliases), -1)
      draft.publicationPrincipals(before, -1)
    } else if (wholeRows) {
      draft.rows(wholeHostRowsFor(wholeRows, id), -1)
    }
    if (after) {
      draft.rows(locate(after, host, aliases), 1)
      draft.publicationPrincipals(after, 1)
    } else if (wholeRows) {
      draft.rows(wholeHostRowsFor(wholeRows, id), 1)
    }
  }
  return draft.finish()
}

function senderIndex(state: AppState): SenderIndex {
  const aliases = senderAliases(state)
  const source = state.agentSenderPublicationsByHost ?? EMPTY
  const cached = indexes.get(source)
  if (cached?.aliases === aliases) {
    return cached.index
  }
  const parts = new Map(
    Object.entries(source).map(([host, scopes]) => [host, hostPart(host, scopes, aliases)])
  )
  for (const host of latestParts.keys()) {
    if (!parts.has(host)) {
      latestParts.delete(host)
    }
  }
  const index: SenderIndex = { parts, results: new Map(), rivals: new Map() }
  indexes.set(source, { aliases, index })
  return index
}

/** A host's claim for an identity: its own rows, then every row a peer runs for its principals. */
function claim(index: SenderIndex, host: string, identity: string): Located | undefined {
  const part = index.parts.get(host)
  let value = part?.identities.get(identity)
  for (const principal of part?.principals.keys() ?? []) {
    for (const executing of index.parts.values()) {
      value = merge(value, executing.attachments.get(principal)?.get(identity))
    }
  }
  return value
}

/** Two hosts claiming one pane make each claim ambiguous; a host never rivals its own claims. */
function contested(index: SenderIndex, location: LocatedAgentSender): boolean {
  const pane = key(location.worktreeId, location.paneKey)
  const id = key(pane, location.host)
  let rival = index.rivals.get(id)
  if (rival === undefined) {
    rival = rivalClaim(index, pane, location.host)
    index.rivals.set(id, rival)
  }
  return rival
}

function rivalClaim(index: SenderIndex, pane: string, claimant: string): boolean {
  for (const [host, part] of index.parts) {
    if (host === claimant) {
      continue
    }
    for (const identity of part.panes.get(pane) ?? []) {
      if (claim(index, host, identity)) {
        return true
      }
    }
    for (const [principal, identity] of part.attachedPanes.get(pane) ?? []) {
      for (const [home, homePart] of index.parts) {
        if (homePart.principals.has(principal) && claim(index, home, identity)) {
          return true
        }
      }
    }
  }
  return false
}

function lookup(index: SenderIndex, host: string, identity: string): Located | undefined {
  const id = key(host, identity)
  if (!index.results.has(id)) {
    const value = claim(index, host, identity)
    index.results.set(id, value && contested(index, value) ? null : value)
  }
  return index.results.get(id)
}

const SENDER_CHANNEL = 'sender\0'
let reads: Set<string> | undefined
/** Runs `read`, returning the sender channels its resolutions read: what to subscribe to. */
export function readingAgentSenders<T>(read: () => T): [T, ReadonlySet<string>] {
  const outer = reads
  reads = new Set()
  const inner = reads
  try {
    return [read(), inner]
  } finally {
    reads = outer
    for (const channel of inner) {
      outer?.add(channel)
    }
  }
}

function sameLocation(a: Located | undefined, b: Located | undefined): boolean {
  return a === b || Boolean(a && b && a.tab === b.tab && JSON.stringify(a) === JSON.stringify(b))
}

/** Hosts starting or stopping publication move every sender on them; that is not keyed. */
export function samePublishingHosts(a: AppState, b: AppState): boolean {
  const before = a.agentSenderPublicationsByHost ?? EMPTY
  const after = b.agentSenderPublicationsByHost ?? EMPTY
  const hosts = Object.keys(before)
  return (
    hosts.length === Object.keys(after).length && hosts.every((host) => Object.hasOwn(after, host))
  )
}

/** Subscribed sender channels whose answer moved between two states sharing tabs and owners. */
export function movedAgentSenderChannels(
  previous: AppState,
  state: AppState,
  channels: Iterable<string>
): string[] {
  let pair: [SenderIndex, SenderIndex] | undefined
  const moved: string[] = []
  for (const channel of channels) {
    if (channel.startsWith(SENDER_CHANNEL)) {
      const [before, after] = (pair ??= [senderIndex(previous), senderIndex(state)])
      const [host, identity]: [string, string] = JSON.parse(channel.slice(SENDER_CHANNEL.length))
      if (!sameLocation(lookup(before, host, identity), lookup(after, host, identity))) {
        moved.push(channel)
      }
    }
  }
  return moved
}

/** The host's answer for one identity; null when two rows or hosts claim it. Read in
 *  `readingAgentSenders`, the identity's channel becomes a dependency. */
export function readAgentSender(
  state: AppState,
  host: string,
  identity: string
): LocatedAgentSender | null | undefined {
  reads?.add(SENDER_CHANNEL + key(host, identity))
  return lookup(senderIndex(state), host, identity)
}
