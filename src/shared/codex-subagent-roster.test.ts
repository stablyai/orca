import { describe, expect, it } from 'vitest'
import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_TYPE_MAX_LENGTH
} from './agent-status-types'
import {
  codexRosterToSnapshots,
  finishCodexSubagent,
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
        model: `gpt-model-${'x'.repeat(AGENT_MODEL_MAX_LENGTH * 2)}`,
        state: 'working'
      },
      10
    )

    const snapshot = codexRosterToSnapshots(roster)?.[0]
    expect([...roster.keys()]).toEqual(['child-1'])
    expect(snapshot?.agentType).toHaveLength(AGENT_TYPE_MAX_LENGTH)
    expect(snapshot?.agentType).not.toContain('\n')
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
})
