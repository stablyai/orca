import { describe, expect, it, vi } from 'vitest'
import './agent-lead-status-fold'
import type { AgentChildWorkInput } from './agent-status-child-work'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import './agent-status-child-work-liveness'
import './agent-status-child-work-projection'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState
} from './agent-status-child-work-display'
import {
  projectAgentChildWorkViews,
  type AgentChildWorkViewAlias
} from './agent-status-child-work-view'
import { createAgentStatusStore } from './agent-status-store'
import { makeStructuredAgentStatusSubject } from './agent-status-subject'

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'
const scope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
} as const
const parent = makeStructuredAgentStatusSubject(scope, SESSION_ID)
const otherParent = makeStructuredAgentStatusSubject(
  { ...scope, workspaceId: 'folder-2' },
  SESSION_ID
)
const FENCE = { invocationId: 'invocation-1', generation: 1 }

function record(childWorkId: string, overrides: Partial<AgentChildWorkInput> = {}) {
  return {
    childWorkId,
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 10,
    observedAt: 20,
    stoppable: true,
    invocation: FENCE,
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  } satisfies AgentChildWorkInput
}

function alias(
  childWorkId: string,
  aliasKind: AgentChildWorkViewAlias['aliasKind'],
  value: string,
  fence = FENCE
): AgentChildWorkViewAlias {
  return { childWorkId, aliasKind, alias: value, fence }
}

describe('projectAgentChildWorkViews', () => {
  it('names a child by its stable provider handle for the current invocation only', () => {
    const old = { invocationId: 'invocation-0', generation: 0 }
    const views = projectAgentChildWorkViews(
      [record('claude'), record('codex'), record('provisional'), record('no-handle')],
      [
        alias('claude', 'tool_use_id', 'toolu_2'),
        alias('claude', 'task_id', 'task-1'),
        alias('codex', 'tool_use_id', 'call-1'),
        alias('codex', 'thread_id', 'thread-child'),
        alias('provisional', 'task_id', 'task-old', old),
        alias('provisional', 'tool_use_id', 'toolu_1'),
        alias('no-handle', 'task_id', 'task-stale', old)
      ]
    )
    expect(views.map((view) => view.providerId)).toEqual([
      'task-1',
      'thread-child',
      'toolu_1',
      undefined
    ])
    expect(views[3]).not.toHaveProperty('providerId')
  })

  it('keeps an owner only when it is present, in the same session, and not on a cycle', () => {
    const views = projectAgentChildWorkViews(
      [
        record('owner'),
        record('shell', { kind: 'command', parentChildWorkId: 'owner' }),
        record('orphan', { kind: 'command', parentChildWorkId: 'removed' }),
        record('elsewhere', { parent: otherParent }),
        record('cross', { kind: 'command', parentChildWorkId: 'elsewhere' }),
        record('cycle-a', { parentChildWorkId: 'cycle-b' }),
        record('cycle-b', { parentChildWorkId: 'cycle-a' }),
        record('into-cycle', { kind: 'command', parentChildWorkId: 'cycle-a' })
      ],
      []
    )
    expect(Object.fromEntries(views.map((view) => [view.id, view.parentChildWorkId]))).toEqual({
      owner: undefined,
      shell: 'owner',
      orphan: undefined,
      elsewhere: undefined,
      cross: undefined,
      'cycle-a': undefined,
      'cycle-b': undefined,
      'into-cycle': 'cycle-a'
    })
  })
})

describe('agentChildWorkOwnedLiveness', () => {
  const views = projectAgentChildWorkViews(
    [
      record('owner', {
        state: 'done',
        membership: 'settled',
        outcome: 'succeeded',
        settledAt: 20
      }),
      record('grandchild', { parentChildWorkId: 'owner', state: 'idle' }),
      record('grandchild-shell', { kind: 'command', parentChildWorkId: 'grandchild' }),
      record('settled-shell', {
        kind: 'command',
        parentChildWorkId: 'owner',
        state: 'done',
        membership: 'settled',
        outcome: 'cancelled',
        settledAt: 20
      }),
      record('unowned-agent')
    ],
    []
  )

  it('reads live work at any depth beneath the child, and nothing else', () => {
    expect(agentChildWorkOwnedLiveness(views, 'owner')).toBe('monitoring')
    expect(agentChildWorkOwnedLiveness(views, 'grandchild')).toBe('monitoring')
    expect(agentChildWorkOwnedLiveness(views, 'unowned-agent')).toBeNull()
  })

  it('terminates on an ownership cycle a caller built by hand', () => {
    const cyclic = [
      { id: 'a', kind: 'agent', state: 'working', membership: 'live', parentChildWorkId: 'b' },
      { id: 'b', kind: 'command', state: 'working', membership: 'live', parentChildWorkId: 'a' }
    ] as const
    // The walk stops on returning to `a`: only the shell beneath it counts.
    expect(agentChildWorkOwnedLiveness(cyclic, 'a')).toBe('monitoring')
    expect(agentChildWorkOwnedLiveness(cyclic, 'b')).toBe('working')
  })
})

describe('one child and the shell it launched, end to end', () => {
  function observation(overrides: Partial<AgentChildWorkAnnounceRequest>) {
    return {
      parent,
      provider: 'claude',
      aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-agent' }],
      fence: FENCE,
      lifetime: 'current',
      kind: 'agent',
      state: 'working',
      membership: 'live',
      observedAt: 10,
      stoppable: true,
      provenance: { source: 'structured-session', producerId: 'journal-1' },
      ...overrides
    } satisfies AgentChildWorkAnnounceRequest
  }

  it('reads the finished child as monitoring while its shell runs, then as done', () => {
    const store = createAgentStatusStore({ epoch: 'epoch-a', mode: 'authority' })
    expect(store.applyMutation({ parent: { subject: parent } })).not.toBeNull()
    let sequence = 0
    const admission = createAgentChildWorkAdmission(store, {
      mintChildWorkId: vi.fn(() => `child-${++sequence}`)
    })
    const shell = observation({
      aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-shell' }],
      kind: 'command',
      parentChildWorkId: 'child-1',
      observedAt: 12
    })
    admission.announce(observation({}))
    admission.announce(shell)
    admission.announce(
      observation({ state: 'done', membership: 'settled', outcome: 'succeeded', observedAt: 20 })
    )
    const display = () => {
      const children = store.getChildren(parent)
      const views = projectAgentChildWorkViews(
        children,
        children.flatMap((child) => store.getAliasesForChild(child.childWorkId))
      )
      const agent = views.find((view) => view.providerId === 'task-agent')
      return (
        agent && deriveAgentChildDisplayState(agent, agentChildWorkOwnedLiveness(views, agent.id))
      )
    }

    expect(display()).toBe('monitoring')
    admission.announce({
      ...shell,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      observedAt: 30
    })
    expect(display()).toBe('done')
  })
})
