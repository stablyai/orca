import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type {
  AgentSenderAssociation,
  AgentSenderPublication
} from '../../../../../shared/orchestration/mailbox/agent-sender-associations'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { AgentMessageSender } from '../../../../../shared/agent-session/agent-session-message-source'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { parseOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { resolveAgentMessageSender } from './agent-sender-associations'
import type { LocatedAgentSender } from './agent-sender-index'
import { agentSenderAliasParts, assembleAgentSenderAliases } from './agent-sender-alias-projection'
import { agentSenderPublicationPatch } from './agent-sender-publication-patch'

const key = (host: string, address: string) => JSON.stringify([host, address])

/** The whole-window rebuild every update used to run: the specification the partitioned index
 *  must match for every input. */
function rebuiltIndex(state: AppState): Map<string, LocatedAgentSender | null> {
  const { windowPane, chatTabs } = assembleAgentSenderAliases(agentSenderAliasParts(state))
  const unique = <T>(map: Map<string, T | null>, id: string, value: T) => {
    if (!map.has(id)) {
      map.set(id, value)
    } else if (JSON.stringify(map.get(id)) !== JSON.stringify(value)) {
      map.set(id, null)
    }
  }
  const effective = (scopes: Record<string, AgentSenderPublication>) => {
    const whole = scopes['*']
    const parts = Object.entries(scopes).flatMap(([id, value]) => (id === '*' ? [] : [value]))
    if (!whole || parts.length === 0) {
      return whole ? [whole] : parts
    }
    const overridden = new Set(Object.keys(scopes))
    return [
      {
        ...whole,
        associations: whole.associations.filter((row) => !overridden.has(row.worktreeId)),
        attachments: whole.attachments.filter((row) => !overridden.has(row.worktreeId))
      },
      ...parts
    ]
  }
  const locate = (host: string, row: AgentSenderAssociation): LocatedAgentSender | null => {
    const actual = windowPane(host, row.paneKey)
    if (actual === null) {
      return null
    }
    const paneKey = actual ?? row.paneKey
    return {
      ...row,
      host,
      paneKey,
      hostPaneKey: row.paneKey,
      tab: chatTabs.get(key(host, paneKey))
    }
  }
  const publications = Object.entries(state.agentSenderPublicationsByHost)
  const attachments = new Map<string, Map<string, LocatedAgentSender | null>>()
  for (const [host, scopes] of publications) {
    for (const publication of effective(scopes)) {
      for (const row of publication.peerFingerprint ? publication.attachments : []) {
        const location = locate(host, row)
        if (location) {
          const principal = key(publication.peerFingerprint!, row.homePeerFingerprint)
          const bucket = attachments.get(principal) ?? new Map()
          attachments.set(principal, bucket)
          unique(bucket, row.identity, location)
        }
      }
    }
  }
  const index = new Map<string, LocatedAgentSender | null>()
  for (const [host, scopes] of publications) {
    const values = effective(scopes)
    for (const row of values.flatMap((publication) => publication.associations)) {
      const location = locate(host, row)
      if (location) {
        unique(index, key(host, row.identity), location)
      }
    }
    const principals = new Set(
      values.flatMap((publication) =>
        publication.principals.map((p) => key(p.peerFingerprint, p.homePeerFingerprint))
      )
    )
    for (const principal of principals) {
      for (const [identity, location] of attachments.get(principal) ?? []) {
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
    if (row) {
      const id = key(row.worktreeId, row.paneKey)
      owners.set(id, owners.has(id) && owners.get(id) !== row.host ? null : row.host)
    }
  }
  for (const [id, row] of index) {
    if (row && owners.get(key(row.worktreeId, row.paneKey)) === null) {
      index.set(id, null)
    }
  }
  return index
}

const HOSTS: ExecutionHostId[] = ['local', 'runtime:a', 'runtime:b']
const FINGERPRINT: Record<string, string> = {
  local: 'fp-l',
  'runtime:a': 'fp-a',
  'runtime:b': 'fp-b'
}
const WORKTREES = ['w0', 'w1', 'w2']
const SESSIONS = ['session_0', 'session_1']
const IDENTITIES = [
  ...Array.from({ length: 12 }, (_, i) => `term_${i}`),
  'dispatch:d0',
  'dispatch:d1',
  ...SESSIONS.map((s) => `orca_session_id:${s}`)
]

function senderFor(identity: string): AgentMessageSender {
  return {
    name: null,
    party: {
      address: identity,
      terminalHandle: identity.startsWith('term_') ? identity : null,
      orcaSessionId: parseOrcaSessionAddress(identity)
    }
  }
}

it('resolves every sender as the whole-window rebuild does across random scope updates', () => {
  let seed = 7
  const random = (n: number) => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    return (seed >>> 16) % n
  }
  const pick = <T>(values: readonly T[]) => values[random(values.length)]
  // Few panes and worktrees so hosts collide, rows disagree and scopes override the baseline.
  const pane = () => {
    const session = pick(SESSIONS)
    return random(3) === 0
      ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(session), session)
      : `tab-${random(3)}:leaf`
  }
  const row = (worktreeId: string): AgentSenderAssociation => ({
    identity: pick(IDENTITIES),
    paneKey: pane(),
    worktreeId: random(5) === 0 ? pick(WORKTREES) : worktreeId,
    ...(random(3) === 0 ? { sessionId: pick(SESSIONS) } : {}),
    ...(random(2) === 0 ? { dispatchActor: true as const } : {})
  })
  const base = useAppStore.getState()
  let revision = 0
  let state: AppState = { ...base, agentSenderPublicationsByHost: {} }
  const seen: AppState[] = []
  const kinds = new Set<string>()
  for (let step = 0; step < 600; step++) {
    const host = pick(HOSTS)
    const scope = random(3) === 0 ? '*' : pick(WORKTREES)
    const rows = (n: number) =>
      Array.from({ length: random(n) }, () => row(scope === '*' ? pick(WORKTREES) : scope))
    const peers = HOSTS.filter((other) => other !== host && random(2) === 0)
    const publication: AgentSenderPublication = {
      associations: rows(4),
      ...(random(4) !== 0 ? { peerFingerprint: FINGERPRINT[host] } : {}),
      // How each execution peer names this host, and the rows this host runs for other homes.
      principals: peers.map((peer) => ({
        peerFingerprint: FINGERPRINT[peer],
        homePeerFingerprint: `home-${host}`
      })),
      attachments: rows(3).map((attached) => ({
        ...attached,
        homePeerFingerprint: `home-${pick(HOSTS)}`
      })),
      revision: { epoch: 'e', revision: ++revision }
    }
    const roll = random(12)
    const patch =
      roll === 0
        ? agentSenderPublicationPatch(state, host, '*', undefined)
        : roll === 1
          ? agentSenderPublicationPatch(state, host, scope, undefined, true)
          : agentSenderPublicationPatch(state, host, scope, publication)
    state = { ...state, ...patch }
    if (random(6) === 0) {
      // Chats this window shows under its own names, sometimes two names for one host pane.
      const tabs = SESSIONS.flatMap((session, i) =>
        random(2) === 0
          ? []
          : Array.from({ length: 1 + random(2) }, (_, n) =>
              makeUnifiedTab({
                id: `mirror-${session}-${n}`,
                entityId: session,
                worktreeId: WORKTREES[i],
                groupId: 'g',
                contentType: 'agent-session',
                executionHostId: pick(HOSTS)
              })
            )
      )
      state = { ...state, unifiedTabsByWorktree: { w0: tabs } }
    }
    seen.push(state)
    // An earlier window state, as a retained view reads it, must still answer for itself.
    for (const read of [state, pick(seen)]) {
      const index = rebuiltIndex(read)
      for (const host of HOSTS) {
        for (const identity of IDENTITIES) {
          const location = index.get(key(host, identity))
          const expected = !read.agentSenderPublicationsByHost[host]
            ? { kind: 'legacy' }
            : location === null
              ? { kind: 'ambiguous' }
              : location && (!identity.startsWith('dispatch:') || location.dispatchActor)
                ? { kind: 'located', location }
                : {
                    kind: 'gone',
                    sender: identity.startsWith('orca_session_id:')
                      ? 'chat'
                      : identity.startsWith('term_')
                        ? 'terminal'
                        : 'other'
                  }
          kinds.add(
            location?.tab ? 'chat' : location && location.host !== host ? 'attached' : expected.kind
          )
          expect(resolveAgentMessageSender(read, host, senderFor(identity))).toEqual(expected)
        }
      }
    }
  }
  expect([...kinds].sort()).toEqual(['ambiguous', 'attached', 'chat', 'gone', 'legacy', 'located'])
})
