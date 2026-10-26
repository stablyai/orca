import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finishJcodeSubagent,
  jcodeRosterToSnapshots,
  reapUnconfirmedRestoredJcodeSubagents,
  seedJcodeSubagentRoster,
  upsertJcodeSubagent,
  type JcodeSubagentRoster
} from './jcode-subagent-roster'
import { dolphinHooks } from './agent-hook-listener-jcode-swarm-fixtures'

describe('Jcode subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(30)
  })
  afterEach(() => vi.useRealTimers())
  it('exports and restores the captured worker report without replacing its title or identity', () => {
    const { message } = JSON.parse(dolphinHooks[4].tool_input)
    const { prompt } = JSON.parse(dolphinHooks[2].tool_input)
    const roster: JcodeSubagentRoster = new Map()
    const id = dolphinHooks[4].session_id
    upsertJcodeSubagent(
      roster,
      id,
      {
        state: 'working',
        agentType: 'octopus',
        description: prompt,
        model: dolphinHooks[3].model
      },
      10
    )
    upsertJcodeSubagent(roster, id, { state: 'working', report: message }, 20)
    upsertJcodeSubagent(roster, id, { state: 'idle' }, 30)
    const snapshots = jcodeRosterToSnapshots(roster)
    expect(snapshots).toEqual([
      {
        id,
        state: 'idle',
        startedAt: 10,
        agentType: 'octopus',
        description: prompt,
        model: 'claude-haiku-5-5',
        lastAssistantMessage: message
      }
    ])
    const restored: JcodeSubagentRoster = new Map()
    seedJcodeSubagentRoster(restored, snapshots ?? [])
    expect(jcodeRosterToSnapshots(restored)).toEqual(snapshots)
  })

  it('normalizes fields and rejects ids that snapshots cannot carry', () => {
    const roster: JcodeSubagentRoster = new Map()
    for (const id of ['', ' '.repeat(3), 'x'.repeat(65)]) {
      upsertJcodeSubagent(roster, id, { state: 'working' }, 10)
    }
    expect(roster.size).toBe(0)
    upsertJcodeSubagent(
      roster,
      ` ${'x'.repeat(64)} `,
      {
        state: 'working',
        agentType: ` ${'a'.repeat(60)}\n`,
        description: ` ${'d'.repeat(200)}`,
        model: ` ${'m'.repeat(140)}`
      },
      10
    )
    expect(jcodeRosterToSnapshots(roster)).toEqual([
      {
        id: 'x'.repeat(64),
        state: 'working',
        startedAt: 10,
        agentType: 'a'.repeat(40),
        description: 'd'.repeat(160),
        model: 'm'.repeat(120)
      }
    ])
  })

  it('retains idle membership, report and first clock until close', () => {
    const roster: JcodeSubagentRoster = new Map()
    upsertJcodeSubagent(roster, 'worker', { state: 'working', agentType: 'retriever' }, 10)
    upsertJcodeSubagent(roster, 'worker', { state: 'working', report: '  finished\nwork  ' }, 20)
    upsertJcodeSubagent(roster, 'worker', { state: 'idle', model: 'claude-haiku-5-5' }, 30)
    expect(roster.get('worker')).toMatchObject({
      state: 'idle',
      startedAt: 10,
      agentType: 'retriever',
      report: 'finished\nwork'
    })
    finishJcodeSubagent(roster, 'worker')
    expect(jcodeRosterToSnapshots(roster)).toBeUndefined()
  })

  it('sorts equal clocks by id and restores without replacing live entries', () => {
    const roster: JcodeSubagentRoster = new Map()
    upsertJcodeSubagent(roster, 'b', { state: 'working' }, 20)
    upsertJcodeSubagent(roster, 'a', { state: 'idle' }, 20)
    seedJcodeSubagentRoster(roster, [
      { id: 'b', state: 'idle', startedAt: 1 },
      { id: 'old', state: 'working', startedAt: 2 }
    ])
    expect(jcodeRosterToSnapshots(roster)?.map((child) => child.id)).toEqual(['old', 'a', 'b'])
    expect(roster.get('b')).toMatchObject({ state: 'working', startedAt: 20 })
    expect(roster.get('old')?.restoredFromSnapshot).toBe(true)
    expect(reapUnconfirmedRestoredJcodeSubagents(roster)).toBe(true)
    expect(reapUnconfirmedRestoredJcodeSubagents(roster)).toBe(false)
    expect(roster.size).toBe(2)
  })

  it('live activity confirms restored workers', () => {
    const roster: JcodeSubagentRoster = new Map()
    seedJcodeSubagentRoster(roster, [{ id: 'worker', state: 'working', startedAt: 1 }])
    upsertJcodeSubagent(roster, 'worker', { state: 'idle' }, 20)
    expect(reapUnconfirmedRestoredJcodeSubagents(roster)).toBe(false)
    expect(roster.get('worker')).toMatchObject({ state: 'idle', startedAt: 1 })
  })
})
