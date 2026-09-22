import { describe, expect, it } from 'vitest'
import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_TYPE_MAX_LENGTH
} from './agent-status-types'
import {
  codexRosterToSnapshots,
  finishCodexSubagent,
  seedCodexSubagentRoster,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'

describe('Codex subagent roster', () => {
  it('normalizes retained identity fields before storing them', () => {
    const roster: CodexSubagentRoster = new Map()

    upsertCodexSubagent(
      roster,
      ' child-1 ',
      {
        agentType: `reviewer\n${'x'.repeat(AGENT_TYPE_MAX_LENGTH * 2)}`,
        description: 'Review the sidebar lifecycle',
        model: `gpt-model-${'x'.repeat(AGENT_MODEL_MAX_LENGTH * 2)}`,
        state: 'working'
      },
      10
    )

    const snapshot = codexRosterToSnapshots(roster)?.[0]
    expect([...roster.keys()]).toEqual(['child-1'])
    expect(snapshot?.agentType).toHaveLength(AGENT_TYPE_MAX_LENGTH)
    expect(snapshot?.agentType).not.toContain('\n')
    expect(snapshot?.description).toBe('Review the sidebar lifecycle')
    expect(snapshot?.model).toHaveLength(AGENT_MODEL_MAX_LENGTH)

    finishCodexSubagent(roster, ' child-1 ')
    expect(roster.size).toBe(0)
  })

  it('rejects an id that would normalize to an invisible child', () => {
    const roster: CodexSubagentRoster = new Map()

    upsertCodexSubagent(roster, '   ', { state: 'waiting' }, 10)

    expect(roster.size).toBe(0)
  })

  it('bounds live storage while admitting a replacement after one child stops', () => {
    const roster: CodexSubagentRoster = new Map()
    for (let index = 0; index <= AGENT_STATUS_MAX_SUBAGENTS; index += 1) {
      upsertCodexSubagent(roster, `child-${index}`, { state: 'working' }, index)
    }

    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)
    expect(roster.has(`child-${AGENT_STATUS_MAX_SUBAGENTS}`)).toBe(false)

    finishCodexSubagent(roster, 'child-0')
    upsertCodexSubagent(roster, 'replacement', { state: 'working' }, 100)

    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)
    expect(roster.has('replacement')).toBe(true)
  })

  describe('setCodexSubagentModel', () => {
    it('records the model without disturbing the child lifecycle or label', () => {
      const roster: CodexSubagentRoster = new Map()
      upsertCodexSubagent(roster, 'child-1', { description: '/root/audit', state: 'waiting' }, 10)

      setCodexSubagentModel(roster, 'child-1', ' gpt-5.6-terra ')

      expect(codexRosterToSnapshots(roster)).toEqual([
        {
          id: 'child-1',
          agentType: undefined,
          description: '/root/audit',
          model: 'gpt-5.6-terra',
          state: 'waiting',
          startedAt: 10
        }
      ])
    })

    it('never creates a row for a child that is no longer tracked', () => {
      const roster: CodexSubagentRoster = new Map()
      upsertCodexSubagent(roster, 'child-1', { state: 'working' }, 10)
      finishCodexSubagent(roster, 'child-1')

      // A model read racing a completed child must not resurrect its row.
      setCodexSubagentModel(roster, 'child-1', 'gpt-5.6-terra')

      expect(roster.size).toBe(0)
    })

    it('keeps a known model when the new value is empty', () => {
      const roster: CodexSubagentRoster = new Map()
      upsertCodexSubagent(roster, 'child-1', { model: 'gpt-5.6-sol', state: 'working' }, 10)

      setCodexSubagentModel(roster, 'child-1', '   ')
      setCodexSubagentModel(roster, 'child-1', undefined)

      expect(roster.get('child-1')?.model).toBe('gpt-5.6-sol')
    })

    it('bounds an oversized model to the shared cap', () => {
      const roster: CodexSubagentRoster = new Map()
      upsertCodexSubagent(roster, 'child-1', { state: 'working' }, 10)

      setCodexSubagentModel(roster, 'child-1', 'x'.repeat(AGENT_MODEL_MAX_LENGTH + 50))

      expect(roster.get('child-1')?.model).toHaveLength(AGENT_MODEL_MAX_LENGTH)
    })
  })
})

describe('Codex child activity evidence', () => {
  it('advances a pinged child clock while its spawn stamp and the sibling sort hold', () => {
    const roster: CodexSubagentRoster = new Map()
    upsertCodexSubagent(roster, 'c1', { state: 'working' }, 100, 100)
    upsertCodexSubagent(roster, 'c2', { state: 'working' }, 200, 200)

    // A tool event from ONE child: the quiet sibling must not inherit its recency.
    upsertCodexSubagent(roster, 'c1', { state: 'working' }, 5000, 5000)

    const after = codexRosterToSnapshots(roster)
    expect(after?.map((snapshot) => snapshot.id)).toEqual(['c1', 'c2'])
    expect(after?.map((snapshot) => snapshot.startedAt)).toEqual([100, 200])
    expect(after?.map((snapshot) => snapshot.evidenceObservedAt)).toEqual([5000, 200])
  })

  it('never backdates recency to a spawn stamp on a call that only carries one', () => {
    const roster: CodexSubagentRoster = new Map()
    // The transcript scan passes the child's SPAWN time as its creation clock.
    upsertCodexSubagent(roster, 'c1', { state: 'working' }, 100)
    expect(codexRosterToSnapshots(roster)?.[0].evidenceObservedAt).toBeUndefined()

    upsertCodexSubagent(roster, 'c1', { state: 'working' }, 100, 5000)
    setCodexSubagentModel(roster, 'c1', 'gpt-5.4')

    // Model discovery is not lifecycle evidence, so it must not move the clock.
    expect(codexRosterToSnapshots(roster)?.[0].evidenceObservedAt).toBe(5000)
  })

  it('restores a seeded child without inventing freshness it never observed', () => {
    const roster: CodexSubagentRoster = new Map()

    seedCodexSubagentRoster(roster, [{ id: 'c1', state: 'working', startedAt: 100 }])
    expect(codexRosterToSnapshots(roster)?.[0].evidenceObservedAt).toBeUndefined()

    const carried: CodexSubagentRoster = new Map()
    seedCodexSubagentRoster(carried, [
      { id: 'c2', state: 'working', startedAt: 100, evidenceObservedAt: 900 }
    ])
    expect(codexRosterToSnapshots(carried)?.[0].evidenceObservedAt).toBe(900)
  })
})
