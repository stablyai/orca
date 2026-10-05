import { describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkAliasInput } from './agent-status-child-work-alias'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { serializeAgentStatusRunAliasIndex } from './agent-status-run-alias-index'
import { createAgentStatusStore } from './agent-status-store'
import { AGENT_STATUS_STORE_LIMITS } from './agent-status-store-contract'
import { commitAgentStatusStoreMutation } from './agent-status-store-commit'
import { indexAgentStatusStoreState } from './agent-status-store-indexes'
import { agentStatusStoreStateFromSnapshot } from './agent-status-store-state'
import {
  agentStatusSubjectsEqual,
  makePtyRunAgentStatusSubject,
  makeStructuredAgentStatusSubject,
  type AgentStatusExecutionScope
} from './agent-status-subject'

const scope: AgentStatusExecutionScope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

function child(
  parent: ReturnType<typeof makeStructuredAgentStatusSubject>,
  childIndex: number,
  description = 'x'.repeat(8_000)
) {
  return {
    childWorkId: `child-${childIndex}`,
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: `invocation-${childIndex}`, generation: 1 },
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    description
  } satisfies AgentChildWorkInput
}

function children(parent: ReturnType<typeof makeStructuredAgentStatusSubject>, offset: number) {
  return Array.from({ length: AGENT_STATUS_STORE_LIMITS.mutationEntries / 2 }, (_, index) =>
    child(parent, offset + index)
  )
}

describe('AgentStatusStore bounds', () => {
  it('rejects a mutation that would make the aggregate snapshot exceed its byte budget', () => {
    const parent = makeStructuredAgentStatusSubject(scope, 'session-1')
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
    expect(store.applyMutation({ children: children(parent, 0) })).not.toBeNull()

    expect(store.applyMutation({ children: children(parent, 1_024) })).toBeNull()
    expect(store.getSnapshot().children).toHaveLength(1_024)
  })

  it('serializes a derived provider-alias Set above the former 256-run ceiling', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    for (let index = 0; index < 257; index += 1) {
      const runId = `run-${index}`
      expect(
        store.applyMutation({
          parent: {
            subject: makePtyRunAgentStatusSubject(scope, runId),
            run: {
              runId,
              paneKey: `pane-${index}`,
              attachment: { executionId: `execution-${index}` },
              attribution: 'token',
              providerSessions: [
                {
                  provider: 'claude',
                  sessionKeyKind: 'session_id',
                  providerId: 'shared-provider-id'
                }
              ],
              role: 'root',
              verdict: 'live'
            }
          }
        })
      ).not.toBeNull()
    }

    expect(() => serializeAgentStatusRunAliasIndex(store.getRunAliasIndex())).not.toThrow()
  })

  it('reuses immutable record byte measurements when one child changes', () => {
    const parent = makeStructuredAgentStatusSubject(scope, 'session-1')
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const first = child(parent, 0, 'first-description')
    const unchanged = child(parent, 1, 'unchanged-description')
    expect(
      store.applyMutation({ parent: { subject: parent }, children: [first, unchanged] })
    ).not.toBeNull()
    const stringify = vi.spyOn(JSON, 'stringify')

    try {
      expect(
        store.applyMutation({ children: [{ ...first, observedAt: first.observedAt + 1 }] })
      ).not.toBeNull()
      const serializedValues = stringify.mock.results
        .map((result) => result.value)
        .filter((value): value is string => typeof value === 'string')
      expect(serializedValues.some((value) => value.includes('unchanged-description'))).toBe(false)
    } finally {
      stringify.mockRestore()
    }
  })

  it("removes a child batch's aliases without reading any other child's aliases", () => {
    const parent = makeStructuredAgentStatusSubject(scope, 'session-1')
    const bystander = makeStructuredAgentStatusSubject(scope, 'session-2')
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    const aliasFor = (
      record: ReturnType<typeof child>,
      index: number
    ): AgentChildWorkAliasInput => ({
      parent: record.parent,
      provider: record.provider,
      segmentId: `segment-${index}`,
      kind: record.kind,
      aliasKind: 'task_id',
      alias: `task-${index}`,
      childWorkId: record.childWorkId,
      fence: record.invocation
    })
    const removed = Array.from({ length: 4 }, (_, index) => child(parent, index, 'brief'))
    const kept = Array.from({ length: 16 }, (_, index) => child(bystander, index + 4, 'brief'))
    expect(
      store.applyMutation({
        parent: { subject: parent },
        children: removed,
        aliases: removed.map(aliasFor)
      })
    ).not.toBeNull()
    expect(
      store.applyMutation({
        parent: { subject: bystander },
        children: kept,
        aliases: kept.map((record, index) => aliasFor(record, index + 4))
      })
    ).not.toBeNull()
    const state = agentStatusStoreStateFromSnapshot(store.getSnapshot(), 'epoch-a')
    if (!state) {
      throw new Error('Expected a valid store state')
    }
    const indexes = indexAgentStatusStoreState(state)
    let bystanderReads = 0
    for (const [key, record] of state.aliases) {
      if (!agentStatusSubjectsEqual(record.parent, bystander)) {
        continue
      }
      const measured = { ...record }
      Object.defineProperty(measured, 'childWorkId', {
        enumerable: true,
        get: () => {
          bystanderReads += 1
          return record.childWorkId
        }
      })
      state.aliases.set(key, measured)
    }

    expect(
      commitAgentStatusStoreMutation(
        state,
        indexes,
        { removeChildren: removed.map((record) => record.childWorkId) },
        state.revision + 1
      )
    ).toBe(true)
    expect(state.aliases.size).toBe(kept.length)
    expect(bystanderReads).toBe(0)
  })
})
