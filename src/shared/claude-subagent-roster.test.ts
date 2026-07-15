import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import {
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots,
  claudeTeammateIdMatchesName,
  finishClaudeSubagent,
  foldClaudeBackgroundTasksIntoRoster,
  markClaudeTeammateIdleByName,
  readClaudeBackgroundAgentTasks,
  upsertWorkingClaudeSubagent,
  type ClaudeSubagentRoster
} from './claude-subagent-roster'

describe('claude-subagent-roster', () => {
  it('removes a finished one-shot subagent on stop', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)

    // Why: retaining finished one-shots as idle rows piled up dozens of dead
    // "Idle - general-purpose" sidebar rows over a long workflow session.
    finishClaudeSubagent(roster, 'a1')
    expect(roster.size).toBe(0)
    expect(claudeRosterToSnapshots(roster)).toBeUndefined()
  })

  it('idles a teammate on stop instead of removing it', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    finishClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'idle', teammate: true })
  })

  it('removes a finished workflow lane despite its teammate-shaped id when task-listed', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: workflow lanes get name-embedding ids (afinder-C-<hex>) like
    // teammates, but their SubagentStop payload lists them id-exact as a
    // subagent task — real teammate lifecycle ids never appear there.
    upsertWorkingClaudeSubagent(
      roster,
      'afinder-C-5d713c0781b7f8d2',
      { agentType: 'finder-C' },
      100
    )
    finishClaudeSubagent(roster, 'afinder-C-5d713c0781b7f8d2', { listedAsSubagentTask: true })
    expect(roster.size).toBe(0)
  })

  it('reclassifies a task-listed teammate-shaped entry as a one-shot', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(
      roster,
      'av1-streaming-0b1c2d3e',
      { agentType: 'v1-streaming' },
      100
    )
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        {
          id: 'av1-streaming-0b1c2d3e',
          agentType: 'v1-streaming',
          description: undefined,
          running: true,
          teammate: false
        },
        {
          id: 'tteam1',
          agentType: undefined,
          description: undefined,
          running: true,
          teammate: true
        }
      ],
      200
    )
    // A later stop without its own inventory still removes it: the fold
    // already proved the id is a task id, not a teammate.
    finishClaudeSubagent(roster, 'av1-streaming-0b1c2d3e')
    expect(roster.has('av1-streaming-0b1c2d3e')).toBe(false)
  })

  it('removes teammate-shaped leftovers when a complete inventory lists no teammates', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'acr-triage-1-c5a0588e', { agentType: 'cr-triage-1' }, 100)
    finishClaudeSubagent(roster, 'acr-triage-1-c5a0588e')
    expect(roster.get('acr-triage-1-c5a0588e')).toMatchObject({ state: 'idle' })
    upsertWorkingClaudeSubagent(roster, 'afix-main-11223344', { agentType: 'fix-main' }, 150)

    // Why: a teams session lists its teammates (even idle) as teammate-typed
    // tasks; an inventory with none proves these name-shaped rows are dead
    // workflow lanes, not resumable teammates.
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        {
          id: 'aunrelated0000001',
          agentType: 'general-purpose',
          description: undefined,
          running: true,
          teammate: false
        }
      ],
      200
    )
    expect(roster.has('acr-triage-1-c5a0588e')).toBe(false)
    expect(roster.has('afix-main-11223344')).toBe(false)
    expect(roster.has('aunrelated0000001')).toBe(true)
  })

  it('re-marks an idle teammate working without resetting startedAt', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    finishClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { description: 'round two' }, 200)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({
      state: 'working',
      startedAt: 100,
      description: 'round two'
    })
  })

  it('ignores unknown ids on finishClaudeSubagent', () => {
    const roster: ClaudeSubagentRoster = new Map()
    finishClaudeSubagent(roster, 'ghost')
    expect(roster.size).toBe(0)
  })

  it('caps roster size, evicting the oldest idle entry first', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 0)
    for (let i = 1; i < AGENT_STATUS_MAX_SUBAGENTS; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, i)
    }
    // Why: all working — a new spawn cannot evict live children and is dropped.
    upsertWorkingClaudeSubagent(roster, 'overflow', {}, 999)
    expect(roster.has('overflow')).toBe(false)

    // Why: only teammates hold idle entries now; an idle teammate is the
    // eviction pool when a burst of new spawns hits the cap.
    finishClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    upsertWorkingClaudeSubagent(roster, 'replacement', {}, 1000)
    expect(roster.has('replacement')).toBe(true)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(false)
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

  it('marks a background task inventory truncated after the snapshot cap', () => {
    const tasks = Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 1 }, (_, index) => ({
      id: `a${index}`,
      type: 'subagent',
      status: 'running'
    }))
    const result = readClaudeBackgroundAgentTasks({ background_tasks: tasks })
    expect(result.tasks).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
    expect(result.truncated).toBe(true)
  })

  it('folds background_tasks in without trusting ambiguous entries', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    upsertWorkingClaudeSubagent(roster, 'ateam-6d3cb5b5', { agentType: 'security-reviewer' }, 150)

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
    // Why: the working lifecycle-tracked teammate is not listed by id, but
    // omission proves nothing for teammates — it must survive the fold.
    expect(roster.get('ateam-6d3cb5b5')).toMatchObject({
      state: 'working',
      agentType: 'security-reviewer'
    })
  })

  it('removes an id-matched task reported not running', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [{ id: 'a1', agentType: undefined, description: undefined, running: false, teammate: false }],
      200
    )
    expect(roster.size).toBe(0)
  })

  it('removes a killed one-shot missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: a running one-shot is always listed id-exact at a lead Stop, so a
    // working non-teammate missing from the list is dead (SubagentStop lost);
    // keeping it pinned the pane 'working' forever.
    upsertWorkingClaudeSubagent(roster, 'akilled0000000001', { agentType: 'general-purpose' }, 100)
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.size).toBe(0)
  })

  it('retains an unlisted live child when the background task inventory was truncated', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'alive-after-cap', {}, 100)
    const parsed = readClaudeBackgroundAgentTasks({
      background_tasks: Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 1 }, (_, index) => ({
        id: index === AGENT_STATUS_MAX_SUBAGENTS ? 'alive-after-cap' : `a${index}`,
        type: 'subagent',
        status: 'running'
      }))
    })

    foldClaudeBackgroundTasksIntoRoster(roster, parsed.tasks, 200, {
      inventoryComplete: !parsed.truncated
    })
    expect(roster.has('alive-after-cap')).toBe(true)
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

  it('removes non-teammate authoritative entries and keeps live teammates on omission', () => {
    const roster: ClaudeSubagentRoster = new Map()
    roster.set('a-phantom', {
      state: 'working',
      startedAt: 100,
      backgroundTasksAuthoritative: true
    })
    upsertWorkingClaudeSubagent(roster, 'ateam-6d3cb5b5', { agentType: 'security-reviewer' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.has('a-phantom')).toBe(false)
    expect(roster.get('ateam-6d3cb5b5')).toMatchObject({ state: 'working' })
  })

  it('demotes a seeded teammate phantom missing from a present list to idle', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: a teammate seeded from a pre-restart snapshot may be dead, but its
    // task id never appears in background_tasks — demote instead of delete so
    // a live idle teammate keeps its row while a phantom stops gating the pane.
    roster.set('aprobe1-6d3cb5b5', {
      state: 'working',
      startedAt: 100,
      agentType: 'probe1',
      teammate: true,
      backgroundTasksAuthoritative: true
    })
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'idle', teammate: true })
  })

  it('removes fold-recreated entries missing from a later present list', () => {
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
    expect(roster.has('a9')).toBe(false)
  })

  it('keeps a re-tracked working teammate missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    roster.set('aprobe1-6d3cb5b5', {
      state: 'working',
      startedAt: 100,
      agentType: 'probe1',
      teammate: true,
      backgroundTasksAuthoritative: true
    })
    // Why: live activity clears the authoritative flag; a busy teammate must
    // not be demoted by a Stop that (as always) omits its lifecycle id.
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        { id: 'other', agentType: undefined, description: undefined, running: true, teammate: true }
      ],
      200
    )
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'working' })
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
