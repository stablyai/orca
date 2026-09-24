// Cross-version coverage for the agent-status wire, paired the way the terminal and
// structured-session harnesses are: current code against a real published release.
//
// The execution host owns agent status in one store and every reader subscribes to it,
// so a remote host and its client each run their own copy of that store. The two update
// independently, which makes three things cross-version surfaces:
//
//   - the snapshot a replica hydrates from. Its decoder rejects a payload carrying a key
//     it does not know, so an added field is NOT Rule 1 here — it breaks the older peer;
//   - the mutation envelope every later change rides on, whose decoder requires an exact
//     key set for the same reason;
//   - the OSC status payload an agent CLI prints, which the host parses into the row the
//     sidebar, `worktree ps`, mobile and the dashboard all read.
//
// `RuntimeWorktreeAgentRow` carries the status arms and working mode into the worktree
// listing, so the arm set is checked here too. The row's remaining members are types with
// no runtime codec; nothing in this file can observe them.

import { beforeAll, describe, expect, it } from 'vitest'
import { comparePublishedFields } from './published-field-shape'
import { resolveBaselineReleaseRef } from './release-checkout'
import {
  loadAgentStatusWireBuild,
  WORKING_TREE,
  type AgentStatusStoreLike,
  type AgentStatusWireBuild
} from './versioned-agent-status-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'
const SCOPE = {
  executionHostId: 'ssh:cross-version-host',
  wslDistro: null,
  workspaceId: 'folder-workspace-cross-version',
  workspaceKind: 'folder'
} as const

let current: AgentStatusWireBuild
let baseline: AgentStatusWireBuild

beforeAll(async () => {
  ;[current, baseline] = await Promise.all([
    loadAgentStatusWireBuild(WORKING_TREE),
    loadAgentStatusWireBuild(resolveBaselineReleaseRef())
  ])
}, SUITE_TIMEOUT_MS)

type AuthoredStore = {
  store: AgentStatusStoreLike
  subject: unknown
  snapshot: Record<string, unknown>
  envelope: Record<string, unknown>
  childWorkId: string
}

/**
 * A host of `build` writing the rows a real session produces, then publishing what a
 * replica would receive: the hydration snapshot, and one mutation envelope after it.
 */
function authorOn(build: AgentStatusWireBuild): AuthoredStore {
  const store = build.createStore({ epoch: 'cross-version-epoch', mode: 'authority' })
  const subject = build.makeStructuredSubject(SCOPE, SESSION_ID)
  expect(
    store.applyMutation({ parent: { subject, firstObservedAt: 10 } }),
    build.label
  ).not.toBeNull()
  const childWorkId = 'cross-version-child-1'
  expect(
    build.announceChild(store, childWorkId, {
      parent: subject,
      provider: 'claude',
      aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
      fence: { invocationId: 'invocation-1', generation: 1 },
      lifetime: 'current',
      kind: 'agent',
      state: 'working',
      membership: 'live',
      observedAt: 20,
      stoppable: true,
      provenance: { source: 'transport', producerId: 'cross-version-fixture' }
    }),
    build.label
  ).toMatchObject({ accepted: true, childWorkId })
  const snapshot = store.getSnapshot()
  const envelope = store.applyMutation({
    facts: [{ subject, key: 'cross-version-fact', value: 'published' }]
  })
  expect(envelope, `${build.label} published no mutation envelope`).not.toBeNull()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertion above fails the test before this runs when the envelope is null.
  return { store, subject, snapshot, envelope: envelope as Record<string, unknown>, childWorkId }
}

/** What one build publishes, carried over the wire exactly as a socket would carry it. */
function overTheWire(frame: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(frame))
}

function describePairing(
  name: string,
  pair: () => { host: AgentStatusWireBuild; client: AgentStatusWireBuild }
): void {
  describe(name, () => {
    it('hydrates a replica from the peer snapshot and applies the mutation that follows', () => {
      const { host, client } = pair()
      const authored = authorOn(host)
      const replica = client.createStore({ epoch: 'replica-placeholder', mode: 'replica' })
      expect(
        replica.applySnapshot(overTheWire(authored.snapshot)),
        `${client.label} refused a snapshot published by ${host.label}`
      ).toBe(true)
      expect(replica.getParent(authored.subject)).toMatchObject({ firstObservedAt: 10 })
      expect(replica.getChild(authored.childWorkId)).toMatchObject({
        state: 'working',
        provider: 'claude'
      })
      expect(
        replica.applyTransportEnvelope(overTheWire(authored.envelope)),
        `${client.label} refused a mutation envelope published by ${host.label}`
      ).toBe(true)
    })

    it('publishes no snapshot field the peer decoder drops the frame over', () => {
      const { host, client } = pair()
      // Both sides author with their own build, so the expectation is what each publishes
      // today rather than a list this file keeps about a release.
      const skew = comparePublishedFields({
        older: Object.keys(authorOn(client).snapshot).sort(),
        newer: Object.keys(authorOn(host).snapshot).sort()
      })
      expect(
        { ...skew, host: host.label, client: client.label },
        'the snapshot decoder refuses unknown keys, so neither direction may differ'
      ).toMatchObject({ added: [], removed: [] })
    })

    it('parses the peer status payload an agent CLI prints', () => {
      const { host, client } = pair()
      const published = host.normalizeStatusPayload({
        state: 'working',
        prompt: 'cross-version prompt',
        agentType: 'claude',
        toolName: 'Read',
        timestamp: 1_700_000_000_000
      })
      expect(published, `${host.label} refused its own status payload`).not.toBeNull()
      expect(
        client.normalizeStatusPayload(overTheWire({ ...published })),
        `${client.label} refused a status payload published by ${host.label}`
      ).toMatchObject({ state: 'working', agentType: 'claude' })
    })
  })
}

describePairing('new host against old client', () => ({ host: current, client: baseline }))
describePairing('old host against new client', () => ({ host: baseline, client: current }))

describe('agent status arms', () => {
  it('keeps every arm the baseline can send readable by current code', () => {
    // Derived from the checked-out baseline: an arm it ships and current code dropped
    // leaves a row whose state no current reader handles. Additions are current's to make.
    expect(baseline.states.length).toBeGreaterThan(0)
    expect(current.states).toEqual(expect.arrayContaining([...baseline.states]))
  })
})
