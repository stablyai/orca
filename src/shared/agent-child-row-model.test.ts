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
})

describe('buildLegacyAgentChildRowModels', () => {
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
  it('lets a resumed live task replace its retained settled row', () => {
    const rows = buildLegacyTaskRowModels(
      [{ id: 'r', kind: 'agent', state: 'working' }],
      [{ id: 'r', kind: 'agent', state: 'done' }]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ settled: false, displayState: 'working' })
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
    expect(context).toEqual({
      parentEvidenceFresh: false,
      transportObservation: 'live',
      parentObservedAt: 1_190_000,
      hostClockOffsetMs: -20 * 60_000
    })
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
})
