import { describe, expect, it } from 'vitest'
import {
  agentChildRowContextForParent,
  buildAgentChildRowModels,
  buildLegacyAgentChildRowModels,
  buildLegacyTaskRowModels,
  flattenAgentChildRowModels,
  type AgentChildRowContext,
  type AgentChildRowModel
} from './agent-child-row-model'
import type { AgentChildWorkView } from './agent-status-child-work-view'

const FRESH: AgentChildRowContext = {
  parentEvidenceFresh: true,
  transportObservation: 'live',
  parentObservedAt: 900,
  hostClockOffsetMs: 0
}
const STALE: AgentChildRowContext = { ...FRESH, parentEvidenceFresh: false }
const LOST: AgentChildRowContext = { ...FRESH, transportObservation: 'unverifiable' }

function view(id: string, overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    description: `child ${id}`,
    agentType: 'general-purpose',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 500,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...overrides
  }
}

function settled(
  id: string,
  outcome: NonNullable<AgentChildWorkView['outcome']>,
  overrides: Partial<AgentChildWorkView> = {}
): AgentChildWorkView {
  return view(id, {
    state: 'done',
    membership: 'settled',
    outcome,
    settledAt: 450,
    ...overrides
  })
}

function shell(id: string, owner: string, overrides: Partial<AgentChildWorkView> = {}) {
  return view(id, {
    kind: 'command',
    description: 'npm run dev',
    agentType: undefined,
    state: 'monitoring',
    parentChildWorkId: owner,
    ...overrides
  })
}

function only(views: AgentChildWorkView[], context = FRESH): AgentChildRowModel {
  const [row] = buildAgentChildRowModels(views, context)
  return row
}

describe('buildAgentChildRowModels: the display vocabulary', () => {
  it.each<[string, AgentChildWorkView[], Pick<AgentChildRowModel, 'displayState' | 'detail'>]>([
    [
      'working with no known operation names its role',
      [view('a')],
      { displayState: 'working', detail: { kind: 'role', agentType: 'general-purpose' } }
    ],
    [
      'working with a foreground tool names the tool the way a CLI row does',
      [view('a', { operation: { toolName: 'Read', basis: 'open', observedAt: 400 } })],
      { displayState: 'working', detail: { kind: 'operation', toolName: 'Read' } }
    ],
    [
      'a foreground shell reads as working with its command',
      [
        view('a', {
          operation: { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: 400 }
        })
      ],
      {
        displayState: 'working',
        detail: { kind: 'operation', toolName: 'Bash', input: 'npm test' }
      }
    ],
    [
      'an idle child whose own shell runs reads monitoring',
      [view('a', { state: 'idle' }), shell('s', 'a')],
      { displayState: 'monitoring', detail: { kind: 'monitoring' } }
    ],
    [
      'a finished child whose own shell runs reads monitoring',
      [settled('a', 'succeeded', { lastMessage: 'All green' }), shell('s', 'a')],
      { displayState: 'monitoring', detail: { kind: 'monitoring' } }
    ],
    [
      'waiting names the tool the approval is for',
      [
        view('a', {
          state: 'waiting',
          operation: { toolName: 'Edit', input: 'src/a.ts', basis: 'open', observedAt: 400 }
        })
      ],
      {
        displayState: 'waiting',
        detail: { kind: 'operation', toolName: 'Edit', input: 'src/a.ts' }
      }
    ],
    [
      'blocked says why',
      [view('a', { state: 'blocked', lastMessage: 'Rate limited' })],
      { displayState: 'blocked', detail: { kind: 'message', text: 'Rate limited' } }
    ],
    [
      'succeeded reads done with its last message',
      [settled('a', 'succeeded', { lastMessage: 'Found 3 call sites' })],
      { displayState: 'done', detail: { kind: 'message', text: 'Found 3 call sites' } }
    ],
    [
      'failed reads failed with its error',
      [settled('a', 'failed', { lastMessage: 'Exit code 1' })],
      { displayState: 'failed', detail: { kind: 'message', text: 'Exit code 1' } }
    ],
    [
      'cancelled reads interrupted and adds no message',
      [settled('a', 'cancelled', { lastMessage: 'half a thought' })],
      { displayState: 'interrupted', detail: { kind: 'role', agentType: 'general-purpose' } }
    ],
    [
      'an ending the lane cannot classify is neutral and says Ended',
      [settled('a', 'unknown')],
      { displayState: 'idle', detail: { kind: 'ended' } }
    ],
    [
      'a parked live child names its role',
      [view('a', { state: 'idle' })],
      { displayState: 'idle', detail: { kind: 'role', agentType: 'general-purpose' } }
    ],
    [
      'a host-reported unverifiable child reports its silence',
      [view('a', { state: 'unverifiable' })],
      { displayState: 'unverifiable', detail: { kind: 'no-update' } }
    ]
  ])('%s', (_name, views, expected) => {
    expect(only(views)).toMatchObject(expected)
  })

  it('suppresses the tool line while monitoring, even when a stale operation arrives', () => {
    const row = only([
      view('a', {
        state: 'idle',
        operation: { toolName: 'Bash', input: 'npm test', basis: 'reported', observedAt: 400 }
      }),
      shell('s', 'a')
    ])
    expect(row.displayState).toBe('monitoring')
    expect(row.detail).toEqual({ kind: 'monitoring' })
  })

  it('makes every live claim unverifiable under a stale parent or a lost transport', () => {
    for (const context of [STALE, LOST]) {
      expect(only([view('a')], context)).toMatchObject({
        displayState: 'unverifiable',
        detail: { kind: 'no-update' }
      })
      // A finished child's monitoring is a claim about live work; its outcome is history.
      expect(only([settled('a', 'succeeded'), shell('s', 'a')], context).displayState).toBe(
        'unverifiable'
      )
      expect(only([settled('a', 'failed')], context).displayState).toBe('failed')
      expect(only([view('a', { state: 'idle' })], context).displayState).toBe('idle')
    }
  })

  it('gives sibling rows their own clocks, never the parent one', () => {
    const [busy, quiet] = buildAgentChildRowModels(
      [view('busy', { observedAt: 880 }), view('quiet', { firstObservedAt: 200, observedAt: 300 })],
      STALE
    )
    expect([busy.recencyAt, quiet.recencyAt]).toEqual([880, 300])
    expect([busy.observedAt, quiet.observedAt]).toEqual([880, 300])
    expect([busy.firstObservedAt, quiet.firstObservedAt]).toEqual([100, 200])
  })

  it('nests owned work under its owner and keeps host order', () => {
    const rows = buildAgentChildRowModels(
      [
        view('a'),
        shell('s', 'a', { state: 'working' }),
        view('b'),
        view('grandchild', { parentChildWorkId: 'a' })
      ],
      FRESH
    )
    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(rows[0].owned.map((row) => row.id)).toEqual(['s', 'grandchild'])
    expect(flattenAgentChildRowModels(rows).map((row) => row.id)).toEqual([
      'a',
      's',
      'grandchild',
      'b'
    ])
    // A shell names itself; only an agent's own tool line can go stale.
    expect(rows[0].owned[0]).toMatchObject({ displayState: 'working', detail: null })
  })

  it('names a row by its label and omits a role that restates it', () => {
    expect(
      only([view('a', { description: '  ', name: 'subagent', agentType: 'Explore' })])
    ).toMatchObject({ name: 'Explore', detail: null })
    expect(only([view('a', { description: undefined, agentType: undefined })])).toMatchObject({
      name: '',
      detail: { kind: 'role', agentType: 'unknown' }
    })
  })

  it('offers a stop only for a live row the host can target', () => {
    expect(only([view('a')]).canStop).toBe(true)
    expect(only([view('a', { providerId: undefined })]).canStop).toBe(false)
    expect(only([view('a', { stoppable: false })]).canStop).toBe(false)
    expect(only([settled('a', 'succeeded')]).canStop).toBe(false)
  })
})

describe('buildLegacyAgentChildRowModels', () => {
  it('reads a legacy snapshot as before: no clock of its own, no outcome, no operation', () => {
    const rows = buildLegacyAgentChildRowModels(
      [
        { id: 'w', state: 'working', startedAt: 10, description: 'Review', agentType: 'Explore' },
        { id: 'i', state: 'idle', startedAt: 20, agentType: 'writer' },
        { id: 'u', state: 'unverifiable', startedAt: 30 }
      ],
      FRESH
    )
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'w',
        providerId: 'w',
        displayState: 'working',
        name: 'Review',
        detail: { kind: 'role', agentType: 'Explore' },
        firstObservedAt: 10,
        recencyAt: 900,
        settled: false,
        canStop: false
      }),
      expect.objectContaining({ id: 'i', displayState: 'idle', name: 'writer', detail: null }),
      expect.objectContaining({
        id: 'u',
        displayState: 'unverifiable',
        detail: { kind: 'no-update' }
      })
    ])
    expect(rows.every((row) => row.observedAt === undefined)).toBe(true)
  })

  it('decays live legacy states under a stale parent, as before', () => {
    const rows = buildLegacyAgentChildRowModels(
      [
        { id: 'w', state: 'working', startedAt: 10 },
        { id: 'q', state: 'waiting', startedAt: 10 },
        { id: 'i', state: 'idle', startedAt: 10 }
      ],
      STALE
    )
    expect(rows.map((row) => row.displayState)).toEqual(['unverifiable', 'unverifiable', 'idle'])
  })
})

describe('buildLegacyTaskRowModels', () => {
  it('keeps the state the host decided and says only its reason', () => {
    const rows = buildLegacyTaskRowModels(
      [
        { id: 'w', kind: 'agent', description: 'Review', state: 'working', startedAt: 10 },
        { id: 'q', kind: 'agent', description: 'Approve', state: 'waiting' },
        { id: 'u', kind: 'agent', description: 'Lost', state: 'unverifiable' },
        { id: 'm', kind: 'monitor', description: 'tail -f log' },
        { id: 'c', kind: 'command', description: 'npm test', stoppable: false }
      ],
      [{ id: 'd', kind: 'agent', description: 'Done', totalTokens: 900 }]
    )
    expect(rows.map((row) => [row.id, row.displayState, row.detail])).toEqual([
      ['d', 'done', null],
      ['w', 'working', null],
      ['q', 'waiting', { kind: 'reason', state: 'waiting' }],
      ['u', 'unverifiable', { kind: 'reason', state: 'unverifiable' }],
      ['m', 'monitoring', null],
      ['c', 'working', null]
    ])
    expect(rows.map((row) => row.canStop)).toEqual([true, true, true, true, true, false])
    expect(rows[0]).toMatchObject({ settled: true, totalTokens: 900 })
  })

  it('lets a resumed live task replace its retained settled row', () => {
    const rows = buildLegacyTaskRowModels(
      [{ id: 'r', kind: 'agent', state: 'working' }],
      [{ id: 'r', kind: 'agent', state: 'done' }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ settled: false, displayState: 'working' })
  })
})

describe('one label rule for every shape a host publishes', () => {
  it.each(['task', ' Subagent ', 'unknown', '   '])(
    'skips the placeholder %j on all three',
    (label) => {
      const [fromView] = buildAgentChildRowModels(
        [view('a', { description: label, agentType: 'Explore' })],
        FRESH
      )
      const [fromSnapshot] = buildLegacyAgentChildRowModels(
        [{ id: 'a', state: 'working', startedAt: 10, description: label, agentType: 'Explore' }],
        FRESH
      )
      const [fromRoster] = buildLegacyTaskRowModels(
        [{ id: 'a', kind: 'agent', state: 'working', description: label, name: 'Explore' }],
        []
      )
      expect([fromView.name, fromSnapshot.name, fromRoster.name]).toEqual([
        'Explore',
        'Explore',
        'Explore'
      ])
    }
  )

  it('leaves a row with no usable label unnamed on all three', () => {
    const [fromSnapshot] = buildLegacyAgentChildRowModels(
      [{ id: 'a', state: 'working', startedAt: 10, description: 'task' }],
      FRESH
    )
    const [fromRoster] = buildLegacyTaskRowModels(
      [{ id: 'a', kind: 'agent', state: 'working', description: 'task' }],
      []
    )
    expect([only([view('a', { description: 'task', agentType: undefined })]).name]).toEqual([''])
    expect([fromSnapshot.name, fromRoster.name]).toEqual(['', ''])
  })
})

describe('agentChildRowContextForParent: the reader clock', () => {
  const MIRRORED_PARENT = {
    // The host's clock runs 20 minutes ahead of this machine's.
    updatedAt: 1_200_000 + 20 * 60_000,
    evidenceObservedAt: 1_190_000 + 20 * 60_000,
    mirroredEvidenceReceivedAt: 1_190_000
  }

  it("measures a mirrored parent on this machine's receipt clock, never the host's", () => {
    const context = agentChildRowContextForParent(MIRRORED_PARENT, false)
    expect(context).toMatchObject({ parentObservedAt: 1_190_000, hostClockOffsetMs: -20 * 60_000 })
    const [legacy] = buildLegacyAgentChildRowModels(
      [{ id: 'a', state: 'working', startedAt: 10 }],
      context
    )
    expect(legacy.recencyAt).toBe(1_190_000)
    // A view's own host stamp moves onto the reader clock; its host-clock age is kept.
    const [child] = buildAgentChildRowModels(
      [view('a', { observedAt: 1_100_000 + 20 * 60_000 })],
      context
    )
    expect(child.recencyAt).toBe(1_100_000)
    expect(child.observedAt).toBe(1_100_000 + 20 * 60_000)
  })

  it('leaves a parent observed on this machine on its own clock', () => {
    expect(
      agentChildRowContextForParent({ updatedAt: 500, evidenceObservedAt: 400 }, true)
    ).toEqual({
      parentEvidenceFresh: true,
      transportObservation: 'live',
      parentObservedAt: 400,
      hostClockOffsetMs: 0
    })
  })
})
