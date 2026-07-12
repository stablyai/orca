import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import {
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots,
  claudeTeammateIdMatchesName,
  foldClaudeBackgroundTasksIntoRoster,
  markClaudeSubagentIdle,
  markClaudeTeammateIdleByName,
  readClaudeBackgroundAgentTasks,
  upsertWorkingClaudeSubagent,
  type ClaudeSubagentRoster
} from './claude-subagent-roster'

describe('claude-subagent-roster', () => {
  it('tracks spawn and stop as working → idle', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)

    markClaudeSubagentIdle(roster, 'a1')
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(false)
    expect(claudeRosterToSnapshots(roster)).toEqual([
      {
        id: 'a1',
        state: 'idle',
        startedAt: 100,
        agentType: 'general-purpose',
        description: undefined
      }
    ])
  })

  it('re-marks an idle subagent working without resetting startedAt', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    markClaudeSubagentIdle(roster, 'a1')
    upsertWorkingClaudeSubagent(roster, 'a1', { description: 'round two' }, 200)
    expect(roster.get('a1')).toMatchObject({
      state: 'working',
      startedAt: 100,
      description: 'round two'
    })
  })

  it('ignores unknown ids on markClaudeSubagentIdle', () => {
    const roster: ClaudeSubagentRoster = new Map()
    markClaudeSubagentIdle(roster, 'ghost')
    expect(roster.size).toBe(0)
  })

  it('caps roster size, evicting the oldest idle entry first', () => {
    const roster: ClaudeSubagentRoster = new Map()
    for (let i = 0; i < AGENT_STATUS_MAX_SUBAGENTS; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, i)
    }
    // Why: all working — a new spawn cannot evict live children and is dropped.
    upsertWorkingClaudeSubagent(roster, 'overflow', {}, 999)
    expect(roster.has('overflow')).toBe(false)

    markClaudeSubagentIdle(roster, 'a3')
    upsertWorkingClaudeSubagent(roster, 'replacement', {}, 1000)
    expect(roster.has('replacement')).toBe(true)
    expect(roster.has('a3')).toBe(false)
    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)
  })

  it('reads only agent-typed background_tasks entries', () => {
    const { present, tasks } = readClaudeBackgroundAgentTasks({
      background_tasks: [
        {
          id: 'a1',
          type: 'subagent',
          status: 'running',
          description: 'review loop',
          agent_type: 'general-purpose'
        },
        { id: 't1', type: 'teammate', status: 'idle', agent_type: 'code-reviewer' },
        { id: 's1', type: 'shell', status: 'running', description: 'npm run dev' },
        { id: '', type: 'subagent', status: 'running' },
        'garbage'
      ]
    })
    expect(present).toBe(true)
    expect(tasks).toEqual([
      {
        id: 'a1',
        agentType: 'general-purpose',
        description: 'review loop',
        running: true,
        teammate: false
      },
      {
        id: 't1',
        agentType: 'code-reviewer',
        description: undefined,
        running: false,
        teammate: true
      }
    ])
  })

  it('reports background_tasks as absent when missing or malformed', () => {
    expect(readClaudeBackgroundAgentTasks({}).present).toBe(false)
    expect(readClaudeBackgroundAgentTasks({ background_tasks: 'nope' }).present).toBe(false)
  })

  it('folds background_tasks in without trusting ambiguous entries', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    markClaudeSubagentIdle(roster, 'a1')
    upsertWorkingClaudeSubagent(roster, 'ateam-xyz', { agentType: 'reviewer' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        {
          id: 'a1',
          agentType: 'general-purpose',
          description: 'review loop',
          running: true,
          teammate: false
        },
        // Why: teammate task ids never match lifecycle agent_ids; unmatched
        // teammate entries must not create phantom duplicate children.
        {
          id: 'tlkjjs0jv',
          agentType: undefined,
          description: 'teammate task',
          running: true,
          teammate: true
        }
      ],
      200
    )

    expect(roster.size).toBe(2)
    // Why: id-exact matches are one-shot subagents whose run state IS reliable.
    expect(roster.get('a1')).toMatchObject({ state: 'working', description: 'review loop' })
    expect(roster.get('ateam-xyz')).toMatchObject({ state: 'working', agentType: 'reviewer' })
  })

  it('recreates unmatched running one-shot subagents after a listener restart', () => {
    const roster: ClaudeSubagentRoster = new Map()
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        {
          id: 'a9',
          agentType: 'general-purpose',
          description: 'long build',
          running: true,
          teammate: false
        },
        {
          id: 'gone',
          agentType: undefined,
          description: undefined,
          running: false,
          teammate: false
        }
      ],
      500
    )
    expect(roster.get('a9')).toMatchObject({ state: 'working', startedAt: 500 })
    // Why: a finished unmatched one-shot leaves no reason to add an idle row.
    expect(roster.has('gone')).toBe(false)
  })

  it('clears the roster when background_tasks reports nothing alive', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [], 100)
    expect(roster.size).toBe(0)
  })

  it('demotes task-id-authoritative entries missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: seeded/bt-sourced ids ARE task ids; absence from a present list
    // proves the task finished. Lifecycle-tracked ids (teammates) prove
    // nothing by absence and must keep their state.
    roster.set('a-phantom', {
      state: 'working',
      startedAt: 100,
      backgroundTasksAuthoritative: true
    })
    upsertWorkingClaudeSubagent(roster, 'ateam-xyz', { agentType: 'reviewer' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.get('a-phantom')).toMatchObject({ state: 'idle' })
    expect(roster.get('ateam-xyz')).toMatchObject({ state: 'working' })
  })

  it('marks fold-recreated entries as task-id-authoritative for later folds', () => {
    const roster: ClaudeSubagentRoster = new Map()
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [{ id: 'a9', agentType: undefined, description: undefined, running: true, teammate: false }],
      100
    )
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.get('a9')).toMatchObject({ state: 'idle' })
  })

  it('stops demoting an entry once live activity re-tracks it', () => {
    const roster: ClaudeSubagentRoster = new Map()
    roster.set('a-seeded', { state: 'working', startedAt: 100, backgroundTasksAuthoritative: true })
    upsertWorkingClaudeSubagent(roster, 'a-seeded', {}, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.get('a-seeded')).toMatchObject({ state: 'working' })
  })

  it('matches teammate ids by name only up to the hyphen-free suffix', () => {
    expect(claudeTeammateIdMatchesName('aprobe1-6d3cb5b5', 'probe1')).toBe(true)
    expect(claudeTeammateIdMatchesName('alane-hooks-6d3cb5b5', 'lane-hooks')).toBe(true)
    expect(claudeTeammateIdMatchesName('alane-hooks-6d3cb5b5', 'lane')).toBe(false)
    expect(claudeTeammateIdMatchesName('aprobe1-6d3cb5b5', 'probe')).toBe(false)
    expect(claudeTeammateIdMatchesName('aprobe1', 'probe1')).toBe(false)
  })

  it('marks teammates idle by name via agent_type or agent_id prefix', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    upsertWorkingClaudeSubagent(roster, 'aother-123', { agentType: 'other' }, 100)

    expect(markClaudeTeammateIdleByName(roster, 'probe1')).toBe(true)
    expect(roster.get('aprobe1-6d3cb5b5')?.state).toBe('idle')
    expect(roster.get('aother-123')?.state).toBe('working')
    // Why: repeat idles are no-ops so lifecycle refreshes don't churn state.
    expect(markClaudeTeammateIdleByName(roster, 'probe1')).toBe(false)
    expect(markClaudeTeammateIdleByName(roster, 'ghost')).toBe(false)
  })

  it('serializes snapshots deterministically ordered by startedAt then id', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'b', {}, 200)
    upsertWorkingClaudeSubagent(roster, 'z', {}, 100)
    upsertWorkingClaudeSubagent(roster, 'a', {}, 100)
    expect(claudeRosterToSnapshots(roster)?.map((s) => s.id)).toEqual(['a', 'z', 'b'])
    expect(claudeRosterToSnapshots(new Map())).toBeUndefined()
  })
})
