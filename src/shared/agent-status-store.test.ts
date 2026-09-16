import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import type { AgentChildWorkAliasInput } from './agent-status-child-work-alias'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { serializeAgentStatusProviderAliasKey } from './agent-status-run-alias-index'
import { createAgentStatusStore } from './agent-status-store'
import {
  AGENT_STATUS_STORE_LIMITS,
  AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS,
  type AgentStatusStoreSnapshot
} from './agent-status-store-contract'
import {
  deserializeAgentStatusStoreSnapshot,
  serializeAgentStatusStoreSnapshot
} from './agent-status-store-persistence'
import {
  makePtyAgentStatusSubject,
  makePtyRunAgentStatusSubject,
  makeStructuredAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusExecutionScope,
  type AgentStatusSubject
} from './agent-status-subject'

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'

function scope(overrides: Partial<AgentStatusExecutionScope> = {}): AgentStatusExecutionScope {
  return {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree',
    ...overrides
  }
}

function subject(overrides: Partial<AgentStatusExecutionScope> = {}): AgentStatusSubject {
  return makeStructuredAgentStatusSubject(scope(overrides), SESSION_ID)
}

function status(parent: AgentStatusSubject, overrides: Partial<AgentStatusIpcPayload> = {}) {
  return {
    state: 'working',
    prompt: 'Ship it',
    paneKey: 'structured-pane-key',
    connectionId: null,
    receivedAt: 20,
    evidenceObservedAt: 18,
    stateStartedAt: 10,
    worktreeId: parent.workspaceId,
    structuredHost: 'owned',
    ...overrides
  } satisfies AgentStatusIpcPayload
}

function child(parent: AgentStatusSubject, overrides: Partial<AgentChildWorkInput> = {}) {
  return {
    childWorkId: 'child-1',
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 12,
    observedAt: 20,
    stoppable: true,
    invocation: { invocationId: 'invocation-1', generation: 1 },
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  } satisfies AgentChildWorkInput
}

function alias(parent: AgentStatusSubject): AgentChildWorkAliasInput {
  return {
    parent,
    provider: 'claude',
    segmentId: 'segment-1',
    kind: 'agent',
    aliasKind: 'task_id',
    alias: 'provider-task-1',
    childWorkId: 'child-1',
    fence: { invocationId: 'invocation-1', generation: 1 }
  }
}

function populatedStore() {
  const parent = subject()
  const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
  const committed = store.applyMutation({
    parent: { subject: parent, status: status(parent), firstObservedAt: 5 },
    children: [child(parent)],
    aliases: [alias(parent)],
    facts: [{ subject: parent, key: 'acknowledged', value: true }]
  })
  expect(committed?.revision).toBe(1)
  return { parent, store }
}

describe('AgentStatusStore', () => {
  it('stores structured status on the parent record and isolates colliding scoped subjects', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const subjects = [
      subject(),
      subject({ wslDistro: 'Ubuntu' }),
      subject({ executionHostId: 'ssh:host-a' }),
      subject({ executionHostId: 'runtime:peer-a' }),
      subject({ workspaceId: 'folder-1', workspaceKind: 'folder' })
    ]

    for (const [index, scopedSubject] of subjects.entries()) {
      expect(
        store.applyMutation({
          parent: {
            subject: scopedSubject,
            status: status(scopedSubject, { prompt: `prompt-${index}` }),
            firstObservedAt: index + 1
          }
        })
      ).not.toBeNull()
    }

    expect(store.getSnapshot().parents).toHaveLength(subjects.length)
    expect(subjects.map((item) => store.getParent(item)?.status?.prompt)).toEqual([
      'prompt-0',
      'prompt-1',
      'prompt-2',
      'prompt-3',
      'prompt-4'
    ])
  })

  it('accepts trusted PTY fixtures while enforcing run and scope consistency', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const pty = makePtyAgentStatusSubject(scope(), 'pane-1')
    const runSubject = makePtyRunAgentStatusSubject(scope(), 'run-1')

    expect(
      store.applyMutation({
        parent: { subject: pty, status: status(pty, { paneKey: 'pane-1' }) }
      })
    ).not.toBeNull()
    expect(
      store.applyMutation({
        parent: { subject: pty, status: status(pty, { paneKey: 'wrong-pane' }) }
      })
    ).toBeNull()
    const run = {
      runId: 'run-1',
      paneKey: 'pane-2',
      attachment: { executionId: 'execution-1' },
      attribution: 'token',
      providerSessions: [
        { provider: 'claude', sessionKeyKind: 'session_id', providerId: 'provider-1' }
      ],
      role: 'root',
      verdict: 'live'
    } as const
    expect(
      store.applyMutation({
        parent: {
          subject: runSubject,
          run,
          status: status(runSubject, {
            paneKey: 'pane-2',
            runId: 'run-1',
            executionId: 'execution-1',
            providerAlias: {
              provider: 'claude',
              sessionKeyKind: 'session_id',
              providerId: 'provider-1'
            }
          })
        }
      })
    ).not.toBeNull()
    expect(store.getParent(runSubject)?.run).toEqual(run)
    expect(
      store.applyMutation({
        parent: {
          subject: runSubject,
          status: status(runSubject, { paneKey: 'pane-2', runId: 'wrong-run' })
        }
      })
    ).toBeNull()
  })

  it('indexes all run owners of one scoped provider session and reconstructs the index on restore', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const providerAlias = {
      ...scope(),
      provider: 'claude',
      sessionKeyKind: 'session_id',
      providerId: 'shared-session'
    } as const
    const aliasKey = serializeAgentStatusProviderAliasKey(providerAlias)
    for (const runId of ['run-1', 'run-2']) {
      const run = {
        runId,
        paneKey: `pane-${runId}`,
        attachment: { executionId: `execution-${runId}` },
        attribution: 'token',
        providerSessions: [
          {
            provider: providerAlias.provider,
            sessionKeyKind: providerAlias.sessionKeyKind,
            providerId: providerAlias.providerId
          }
        ],
        role: 'root',
        verdict: 'live'
      } as const
      expect(
        store.applyMutation({
          parent: { subject: makePtyRunAgentStatusSubject(scope(), runId), run }
        })
      ).not.toBeNull()
    }
    expect(store.getRunAliasIndex().get(aliasKey)).toEqual(new Set(['run-1', 'run-2']))

    const restored = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(restored.applySnapshot(store.getSnapshot())).toBe(true)
    expect(restored.getRunAliasIndex().get(aliasKey)).toEqual(new Set(['run-1', 'run-2']))
    expect(
      store.applyMutation({ removeParent: makePtyRunAgentStatusSubject(scope(), 'run-1') })
    ).not.toBeNull()
    expect(store.getRunAliasIndex().get(aliasKey)).toEqual(new Set(['run-2']))
  })

  it('allows a removed structured session to be observed again at a later revision', () => {
    const parent = subject()
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(store.applyMutation({ parent: { subject: parent, firstObservedAt: 10 } })).not.toBeNull()
    expect(store.applyMutation({ removeParent: parent })).not.toBeNull()
    expect(store.applyMutation({ parent: { subject: parent, firstObservedAt: 30 } })).not.toBeNull()
    expect(store.getParent(parent)?.firstObservedAt).toBe(30)
    expect(store.getSnapshot().tombstones).toContainEqual({
      entity: 'parent',
      key: serializeAgentStatusSubject(parent),
      revision: 2
    })
  })

  it('bounds tombstones while revision envelopes reject stale replay after reacquisition and compaction', () => {
    const parent = subject()
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const first = store.applyMutation({ parent: { subject: parent, firstObservedAt: 10 } })
    expect(first).not.toBeNull()
    const replica = createAgentStatusStore({ epoch: 'replica', mode: 'replica' })
    expect(replica.applySnapshot(store.getSnapshot())).toBe(true)

    const removal = store.applyMutation({ removeParent: parent })
    expect(removal).not.toBeNull()
    expect(replica.applyTransportEnvelope(removal)).toBe(true)
    const reopened = store.applyMutation({ parent: { subject: parent, firstObservedAt: 30 } })
    expect(reopened).not.toBeNull()
    expect(replica.applyTransportEnvelope(reopened)).toBe(true)
    expect(replica.applyTransportEnvelope(first)).toBe(false)
    expect(replica.getParent(parent)?.firstObservedAt).toBe(30)

    expect(
      store.applyMutation({
        removeChildren: Array.from(
          { length: AGENT_STATUS_STORE_LIMITS.tombstones + 1 },
          (_, index) => `unused-child-${index}`
        )
      })
    ).not.toBeNull()
    expect(store.getSnapshot().tombstones).toHaveLength(AGENT_STATUS_STORE_LIMITS.tombstones)
    expect(store.getSnapshot().tombstones.some((item) => item.entity === 'parent')).toBe(false)
    expect(replica.applySnapshot(store.getSnapshot())).toBe(true)
    expect(replica.applyTransportEnvelope(first)).toBe(false)
    expect(replica.getParent(parent)?.firstObservedAt).toBe(30)
  })

  it.fails('does not roll a replica back to a superseded epoch snapshot', () => {
    const parent = subject()
    const first = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    first.applyMutation({ parent: { subject: parent, firstObservedAt: 10 } })
    const second = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    second.applyMutation({ parent: { subject: parent, firstObservedAt: 20 } })
    const replica = createAgentStatusStore({ epoch: 'replica', mode: 'replica' })
    expect(replica.applySnapshot(first.getSnapshot())).toBe(true)
    expect(replica.applySnapshot(second.getSnapshot())).toBe(true)
    expect(replica.applySnapshot(first.getSnapshot())).toBe(false)
    expect(replica.getParent(parent)?.firstObservedAt).toBe(20)
  })

  it('expires tombstones from a restored snapshot after the retention revision window', () => {
    const parent = subject()
    const source = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(source.applyMutation({ removeParent: parent })).not.toBeNull()
    const snapshot = {
      ...source.getSnapshot(),
      revision: AGENT_STATUS_STORE_TOMBSTONE_RETENTION_REVISIONS + 1
    }
    const restored = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })
    expect(restored.applySnapshot(snapshot)).toBe(true)
    expect(restored.getSnapshot().tombstones).toEqual([])
  })

  it('uses parsed immutable copies instead of caller-owned objects', () => {
    const parent = subject()
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const inputStatus = status(parent, {
      subagents: [{ id: 'provider-child', state: 'working', startedAt: 1, description: 'before' }]
    })
    expect(store.applyMutation({ parent: { subject: parent, status: inputStatus } })).not.toBeNull()

    inputStatus.prompt = 'mutated input'
    inputStatus.subagents?.splice(0)
    const first = store.getParent(parent)
    expect(first?.status?.prompt).toBe('Ship it')
    expect(first?.status?.subagents).toHaveLength(1)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first?.status?.subagents)).toBe(true)
    expect(() => first?.status?.subagents?.splice(0)).toThrow()
    expect(store.getParent(parent)?.status?.subagents).toHaveLength(1)
  })

  it('commits parent, child, alias, fact and tombstone state atomically', () => {
    const { parent, store } = populatedStore()
    const before = store.getSnapshot()
    const invalidAlias = { ...alias(parent), provider: 'codex' }

    expect(
      store.applyMutation({
        children: [child(parent, { state: 'waiting', observedAt: 21 })],
        aliases: [invalidAlias],
        facts: [{ subject: parent, key: 'unread', value: true }]
      })
    ).toBeNull()
    expect(store.getSnapshot()).toEqual(before)

    const removal = store.applyMutation({ removeParent: parent })
    const removed = store.getSnapshot()
    expect(removal?.revision).toBe(2)
    expect(removed.parents).toEqual([])
    expect(removed.children).toEqual([])
    expect(removed.aliases).toEqual([])
    expect(removed.facts).toEqual([])
    expect(new Set(removed.tombstones.map((item) => item.entity))).toEqual(
      new Set(['parent', 'child', 'alias', 'fact'])
    )
    expect(new Set(removed.tombstones.map((item) => item.revision))).toEqual(new Set([2]))
  })

  it('never resurrects an exactly removed child id within tombstone retention', () => {
    const { parent, store } = populatedStore()
    expect(store.applyMutation({ removeChildren: ['child-1'] })).not.toBeNull()
    expect(store.applyMutation({ children: [child(parent, { observedAt: 30 })] })).toBeNull()
    expect(store.applyMutation({ removeParent: parent })).not.toBeNull()
  })

  it('persists a bounded snapshot and restores child identity under a new epoch', () => {
    const { parent, store } = populatedStore()
    expect(
      store.applyMutation({ removeFacts: [{ subject: parent, key: 'acknowledged' }] })
    ).not.toBeNull()
    expect(
      store.applyMutation({ facts: [{ subject: parent, key: 'acknowledged', value: true }] })
    ).not.toBeNull()
    const serialized = serializeAgentStatusStoreSnapshot(store.getSnapshot())
    const persisted = deserializeAgentStatusStoreSnapshot(serialized)
    const restarted = createAgentStatusStore({ epoch: 'epoch-b', mode: 'authority' })

    expect(persisted).not.toBeNull()
    expect(restarted.applySnapshot(persisted)).toBe(true)
    expect(restarted.getSnapshot().epoch).toBe('epoch-b')
    expect(restarted.getSnapshot().revision).toBe(3)
    expect(restarted.getChildren(parent)[0]?.childWorkId).toBe('child-1')
    expect(restarted.getChildren(parent)[0]?.firstObservedAt).toBe(12)
  })

  it('fails closed before parsing oversized persistence payloads or allocating huge mutations', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const oversized = ' '.repeat(AGENT_STATUS_STORE_LIMITS.serializedBytes + 1)

    expect(deserializeAgentStatusStoreSnapshot(oversized)).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()

    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(
      store.applyMutation({
        removeChildren: Array.from(
          { length: AGENT_STATUS_STORE_LIMITS.mutationEntries + 1 },
          (_, index) => `child-${index}`
        )
      })
    ).toBeNull()
    expect(store.getSnapshot().revision).toBe(0)
    const scopedSubject = subject()
    expect(
      store.applyMutation({
        parent: {
          subject: scopedSubject,
          status: {
            ...status(scopedSubject),
            orchestration: {
              taskId: 'task-1',
              dispatchId: 'dispatch-1',
              attention: { oversized: 'x'.repeat(300 * 1024) }
            }
          }
        }
      })
    ).toBeNull()
  })

  it('rejects malformed and scope-mismatched snapshots without changing state', () => {
    const { store } = populatedStore()
    const before = store.getSnapshot()
    const malformed: AgentStatusStoreSnapshot = {
      ...before,
      children: [
        {
          ...before.children[0],
          parent: subject({ workspaceId: 'other-workspace' })
        }
      ]
    }

    expect(store.applySnapshot(malformed)).toBe(false)
    expect(store.getSnapshot()).toEqual(before)
  })

  it('serializes subject removal keys exactly in tombstones', () => {
    const { parent, store } = populatedStore()
    expect(store.applyMutation({ removeParent: parent })).not.toBeNull()
    expect(store.getSnapshot().tombstones).toContainEqual({
      entity: 'parent',
      key: serializeAgentStatusSubject(parent),
      revision: 2
    })
  })
})
