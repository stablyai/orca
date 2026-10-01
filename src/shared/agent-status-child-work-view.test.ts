import { describe, expect, it, vi } from 'vitest'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import type { AgentChildWorkInput, AgentChildWorkOutcome } from './agent-status-child-work'
import {
  createAgentChildWorkAdmission,
  type AgentChildWorkAnnounceRequest
} from './agent-status-child-work-admission'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'
import {
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents
} from './agent-status-child-work-projection'
import {
  agentChildWorkOwnedLiveness,
  deriveAgentChildDisplayState
} from './agent-status-child-work-display'
import {
  projectAgentChildWorkViews,
  type AgentChildWorkView,
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
  it('carries what a surface reads and drops host bookkeeping', () => {
    const [view] = projectAgentChildWorkViews(
      [
        record('child-1', {
          name: 'researcher',
          description: 'Investigate',
          agentType: 'researcher',
          model: 'model-a',
          state: 'done',
          membership: 'settled',
          outcome: 'failed',
          settledAt: 18,
          lastMessage: 'Exit code 1',
          totalTokens: 42,
          residency: 'background',
          providerTiming: { startedAt: 1 },
          previousInvocations: [{ fence: { invocationId: 'invocation-0', generation: 0 } }]
        })
      ],
      [alias('child-1', 'task_id', 'task-1')]
    )
    expect(view).toEqual({
      id: 'child-1',
      providerId: 'task-1',
      kind: 'agent',
      name: 'researcher',
      description: 'Investigate',
      agentType: 'researcher',
      model: 'model-a',
      state: 'done',
      membership: 'settled',
      outcome: 'failed',
      lastMessage: 'Exit code 1',
      firstObservedAt: 10,
      observedAt: 20,
      settledAt: 18,
      totalTokens: 42,
      stoppable: true,
      invocation: FENCE
    })
  })

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

type DisplayCase = [
  label: string,
  view: Pick<AgentChildWorkView, 'state' | 'membership' | 'outcome'>,
  owned: AgentChildWorkLiveness,
  expected: ReturnType<typeof deriveAgentChildDisplayState>
]

const liveAs = (state: AgentChildWorkView['state']) => ({ state, membership: 'live' }) as const
const settledAs = (outcome: AgentChildWorkOutcome) =>
  ({ state: 'done', membership: 'settled', outcome }) as const

// Literal expectations (the product table), independent of the implementation.
const DISPLAY: DisplayCase[] = [
  ['working', liveAs('working'), null, 'working'],
  ['working, owning a live shell', liveAs('working'), 'monitoring', 'working'],
  ['waiting, owning a live agent', liveAs('waiting'), 'working', 'waiting'],
  ['blocked, owning a live shell', liveAs('blocked'), 'monitoring', 'blocked'],
  ['idle', liveAs('idle'), null, 'idle'],
  ['idle, owning a live shell', liveAs('idle'), 'monitoring', 'monitoring'],
  ['idle, owning a live agent', liveAs('idle'), 'working', 'working'],
  ['unverifiable, even owning a live shell', liveAs('unverifiable'), 'monitoring', 'unverifiable'],
  ['a shell that stores monitoring', liveAs('monitoring'), null, 'monitoring'],
  ['finished', settledAs('succeeded'), null, 'done'],
  ['finished, owning a live shell', settledAs('succeeded'), 'monitoring', 'monitoring'],
  ['finished, owning a live agent', settledAs('succeeded'), 'working', 'working'],
  ['failed', settledAs('failed'), null, 'failed'],
  ['cancelled', settledAs('cancelled'), null, 'interrupted'],
  ['cancelled, its shell still running', settledAs('cancelled'), 'monitoring', 'monitoring'],
  ['ended, outcome unknown', settledAs('unknown'), null, 'idle']
]

describe('deriveAgentChildDisplayState', () => {
  it.each(DISPLAY)('%s', (_label, view, owned, expected) => {
    expect(deriveAgentChildDisplayState(view, owned)).toBe(expected)
  })

  it.each([
    ['idle', liveAs('idle')],
    ['finished', settledAs('succeeded')]
  ])(
    'gives a %s child with a live shell what the parent-row fold gives a CLI agent',
    (_l, view) => {
      // The same owned work, folded for a CLI agent whose own turn is over.
      const ownedShell = [{ kind: 'command', state: 'working' }] as const
      // A non-literal input, as the view passes it, so the fold's input can lose a field.
      const foldInput = {
        leadState: 'done',
        interrupted: false,
        childWorkLiveness: agentChildWorkLiveness(ownedShell)
      } as const
      expect(foldAgentLeadStatus(foldInput)).toEqual({
        stateName: 'working',
        workingMode: 'monitoring'
      })
      expect(deriveAgentChildDisplayState(view, agentChildWorkLiveness(ownedShell))).toBe(
        'monitoring'
      )
    }
  )
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

describe('legacy shapes derived from views', () => {
  it('publish exactly what today’s wire carries for the same children', () => {
    const views = projectAgentChildWorkViews(
      [
        record('agent', {
          name: 'researcher',
          agentType: 'researcher',
          description: 'Investigate',
          operation: { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: 15 },
          lastMessage: 'Running tests'
        }),
        record('failed-agent', {
          state: 'done',
          membership: 'settled',
          outcome: 'failed',
          settledAt: 20
        }),
        record('shell', { kind: 'command', parentChildWorkId: 'agent', totalTokens: 3 })
      ],
      [
        alias('agent', 'task_id', 'task-agent'),
        alias('failed-agent', 'task_id', 'task-failed'),
        alias('shell', 'task_id', 'task-shell')
      ]
    )
    expect(projectAgentChildWorkLegacySubagents(views)).toEqual([
      {
        id: 'task-agent',
        state: 'working',
        startedAt: 10,
        agentType: 'researcher',
        description: 'Investigate'
      }
    ])
    expect(projectAgentChildWorkLegacyBackgroundTasks(views)).toEqual({
      tasks: [
        {
          id: 'task-agent',
          kind: 'agent',
          description: 'Investigate',
          name: 'researcher',
          state: 'working',
          startedAt: 10,
          stoppable: true
        },
        {
          id: 'task-shell',
          kind: 'command',
          state: 'working',
          startedAt: 10,
          totalTokens: 3,
          stoppable: true
        }
      ],
      settledTasks: [
        { id: 'task-failed', kind: 'agent', state: 'blocked', startedAt: 10, stoppable: true }
      ]
    })
  })

  it.each([
    ['succeeded', 'done'],
    ['failed', 'blocked'],
    ['cancelled', 'idle'],
    ['unknown', 'done']
  ] as const)(
    'reads a settled %s child as the %s task a host publishes today',
    (outcome, state) => {
      const views = projectAgentChildWorkViews(
        [record('child', { state: 'done', membership: 'settled', outcome, settledAt: 20 })],
        [alias('child', 'task_id', 'task-1')]
      )
      expect(projectAgentChildWorkLegacyBackgroundTasks(views).settledTasks?.[0]?.state).toBe(state)
    }
  )
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
