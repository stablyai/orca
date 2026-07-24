import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import {
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots,
  claudeTeammateIdMatchesName,
  foldClaudeBackgroundTasksIntoRoster,
  idleClaudeTeammateByName,
  readClaudeBackgroundAgentTasks,
  stopClaudeSubagent,
  upsertWorkingClaudeSubagent,
  type ClaudeSubagentRoster
} from './claude-subagent-roster'

const task = (
  over: Partial<ReturnType<typeof readClaudeBackgroundAgentTasks>['tasks'][number]>
) => ({
  id: 'a1',
  agentType: undefined,
  description: undefined,
  running: true,
  teammate: false,
  ...over
})

describe('claude-subagent-roster', () => {
  it('removes a finished one-shot subagent on stop', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)

    // Why: retaining finished children as idle rows piled up dozens of dead
    // "Idle - general-purpose" sidebar rows over a long workflow session.
    stopClaudeSubagent(roster, 'a1')
    expect(roster.size).toBe(0)
    expect(claudeRosterToSnapshots(roster)).toBeUndefined()
  })

  it('parks a teammate-shaped named agent as idle on stop', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: on claude 2.1.21x in-process teammates emit SubagentStop at every
    // TURN end while staying alive/resumable — the row must survive as idle
    // (the reported "sidebar never shows my subagents" regression) without
    // gating the pane 'working'.
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    stopClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'idle' })
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(false)
    expect(claudeRosterToSnapshots(roster)).toEqual([
      expect.objectContaining({ id: 'aprobe1-6d3cb5b5', state: 'idle' })
    ])
  })

  it('removes a stopped workflow lane despite its teammate-shaped id', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'alane-hooks-6d3cb5b5', { agentType: 'lane-hooks' }, 100)
    // Why: a fold proved this id is a subagent-typed background task (workflow
    // lane) — its stop is a true finish, not a teammate turn boundary.
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [task({ id: 'alane-hooks-6d3cb5b5', agentType: 'lane-hooks' })],
      150
    )
    stopClaudeSubagent(roster, 'alane-hooks-6d3cb5b5')
    expect(roster.has('alane-hooks-6d3cb5b5')).toBe(false)
  })

  it('restores a parked workflow lane to working when the inventory reports it running', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'alane-hooks-6d3cb5b5', { agentType: 'lane-hooks' }, 100)
    stopClaudeSubagent(roster, 'alane-hooks-6d3cb5b5')

    // Why: lifecycle hooks and the lead Stop inventory can arrive around the
    // same boundary; an authoritative running task must keep the pane gated.
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [task({ id: 'alane-hooks-6d3cb5b5', agentType: 'lane-hooks' })],
      150
    )

    expect(roster.get('alane-hooks-6d3cb5b5')).toMatchObject({
      state: 'working',
      listedAsSubagentTask: true
    })
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)
  })

  it('revives an idle teammate as working while keeping its first-observed startedAt', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    stopClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { description: 'round two' }, 200)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({
      state: 'working',
      startedAt: 100,
      description: 'round two'
    })
  })

  it('re-adds a resumed one-shot as working with a fresh startedAt', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    stopClaudeSubagent(roster, 'a1')
    upsertWorkingClaudeSubagent(roster, 'a1', { description: 'round two' }, 200)
    expect(roster.get('a1')).toMatchObject({ startedAt: 200, description: 'round two' })
  })

  it('ignores unknown ids on stopClaudeSubagent', () => {
    const roster: ClaudeSubagentRoster = new Map()
    stopClaudeSubagent(roster, 'ghost')
    stopClaudeSubagent(roster, 'aghost-6d3cb5b5')
    expect(roster.size).toBe(0)
  })

  it('drops new spawns at the cap rather than evicting working children', () => {
    const roster: ClaudeSubagentRoster = new Map()
    for (let i = 0; i < AGENT_STATUS_MAX_SUBAGENTS; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, i)
    }
    // Why: every tracked entry is working — nothing is safe to evict, so the
    // overflow spawn is dropped (it would be invisible past the wire cap).
    upsertWorkingClaudeSubagent(roster, 'overflow', {}, 999)
    expect(roster.has('overflow')).toBe(false)
    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)

    // Once a child finishes, a new spawn takes the freed slot.
    stopClaudeSubagent(roster, 'a0')
    upsertWorkingClaudeSubagent(roster, 'replacement', {}, 1000)
    expect(roster.has('replacement')).toBe(true)
    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)
  })

  it('evicts the oldest idle teammate to admit a new spawn at the cap', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aold-teammate-6d3cb5b5', {}, 1)
    upsertWorkingClaudeSubagent(roster, 'anew-teammate-6d3cb5b5', {}, 2)
    stopClaudeSubagent(roster, 'aold-teammate-6d3cb5b5')
    stopClaudeSubagent(roster, 'anew-teammate-6d3cb5b5')
    for (let i = 2; i < AGENT_STATUS_MAX_SUBAGENTS; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, 10 + i)
    }
    // Why: a parked idle row is the only thing safe to displace — a working
    // spawn must never be dropped just because idle teammates fill the cap.
    upsertWorkingClaudeSubagent(roster, 'overflow', {}, 999)
    expect(roster.has('overflow')).toBe(true)
    expect(roster.has('aold-teammate-6d3cb5b5')).toBe(false)
    expect(roster.has('anew-teammate-6d3cb5b5')).toBe(true)
    expect(roster.size).toBe(AGENT_STATUS_MAX_SUBAGENTS)
  })

  it('reconciles stale entries before adding replacement tasks at the cap', () => {
    const roster: ClaudeSubagentRoster = new Map()
    for (let i = 0; i < AGENT_STATUS_MAX_SUBAGENTS; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, i)
    }
    const tasks = Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS }, (_, index) =>
      task({ id: index === 0 ? 'replacement' : `a${index}` })
    )

    // Why: a complete inventory can replace a stale child while the roster is
    // full. Reap the stale slot first so the new live child keeps the done-gate.
    foldClaudeBackgroundTasksIntoRoster(roster, tasks, 999)

    expect(roster.has('a0')).toBe(false)
    expect(roster.has('replacement')).toBe(true)
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

  it('trusts id-exact subagent matches and ignores teammate-typed entries', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    // A named agent mid-run: teammate-shaped id, never a task id.
    upsertWorkingClaudeSubagent(roster, 'ateam-6d3cb5b5', { agentType: 'security-reviewer' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        task({ id: 'a1', agentType: 'general-purpose', description: 'review loop' }),
        // Why: teammate task ids never match lifecycle agent_ids; unmatched
        // teammate entries must not create phantom duplicate children.
        task({ id: 'tlkjjs0jv', description: 'teammate task', teammate: true })
      ],
      200
    )

    expect(roster.size).toBe(2)
    expect(roster.get('a1')).toMatchObject({ description: 'review loop' })
    // Why: the working named agent is not listed by id, but a teammate-typed
    // task is present — so omission proves nothing and it survives the fold.
    expect(roster.get('ateam-6d3cb5b5')).toMatchObject({ agentType: 'security-reviewer' })
  })

  it('removes an id-matched subagent task reported not running', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', { agentType: 'general-purpose' }, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'a1', running: false })], 200)
    expect(roster.size).toBe(0)
  })

  it('removes a killed one-shot missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: a running one-shot is always listed id-exact at a lead Stop, so a
    // working hyphen-free child missing from the list is dead (SubagentStop
    // lost); keeping it pinned the pane 'working' forever.
    upsertWorkingClaudeSubagent(roster, 'akilled0000000001', { agentType: 'general-purpose' }, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.size).toBe(0)
  })

  it('keeps a live named agent whose teammate-typed id never appears in the list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: this is the core regression — a running named agent (teammate-shaped
    // id, lifecycle-tracked, never a task id) must survive a lead Stop whose
    // list still shows teammate-typed tasks, or the pane resolves done early.
    upsertWorkingClaudeSubagent(
      roster,
      'aweb-research-8a76b7d7',
      { agentType: 'web-research' },
      100
    )
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [task({ id: 't6s2brfv7', description: 'named agent task', teammate: true })],
      200
    )
    expect(roster.has('aweb-research-8a76b7d7')).toBe(true)
  })

  it('removes teammate-shaped leftovers when a complete inventory lists no teammates', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'acr-triage-1-c5a0588e', { agentType: 'cr-triage-1' }, 100)
    // Why: a session with named agents/teammates always lists at least one
    // teammate-typed task while any is alive; an inventory with none proves
    // this teammate-shaped row is dead (its SubagentStop was lost).
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [task({ id: 'aunrelated0000001', agentType: 'general-purpose' })],
      200
    )
    expect(roster.has('acr-triage-1-c5a0588e')).toBe(false)
    expect(roster.has('aunrelated0000001')).toBe(true)
  })

  it('removes a leftover once a subagent-typed task listed its id id-exact', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(
      roster,
      'av1-streaming-0b1c2d3e',
      { agentType: 'v1-streaming' },
      100
    )
    // A subagent-typed task lists it id-exact → tag it listedAsSubagentTask.
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        task({ id: 'av1-streaming-0b1c2d3e', agentType: 'v1-streaming' }),
        task({ id: 'tteam1', teammate: true })
      ],
      200
    )
    // A later Stop omits it while a teammate-typed task is still present: the
    // subagent-listing proof overrides the teammate-shape protection.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'tteam1', teammate: true })], 300)
    expect(roster.has('av1-streaming-0b1c2d3e')).toBe(false)
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
        task({ id: 'a9', agentType: 'general-purpose', description: 'long build' }),
        task({ id: 'gone', running: false })
      ],
      500
    )
    expect(roster.get('a9')).toMatchObject({ startedAt: 500 })
    // Why: a finished unmatched one-shot leaves no reason to add a row.
    expect(roster.has('gone')).toBe(false)
  })

  it('clears the roster when background_tasks reports nothing alive', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [], 100)
    expect(roster.size).toBe(0)
  })

  it('does not clear the roster on an empty but incomplete (truncated) inventory', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [], 200, { inventoryComplete: false })
    expect(roster.has('a1')).toBe(true)
  })

  it('removes a seeded phantom missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // A snapshot-seeded entry (child finished while Orca was down) is
    // authoritative — a present list omitting it removes it even though its
    // id is teammate-shaped.
    roster.set('aprobe1-6d3cb5b5', {
      state: 'working',
      startedAt: 100,
      agentType: 'probe1',
      backgroundTasksAuthoritative: true
    })
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(false)
  })

  it('keeps a re-tracked working named agent missing from a present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    roster.set('aprobe1-6d3cb5b5', {
      state: 'working',
      startedAt: 100,
      agentType: 'probe1',
      backgroundTasksAuthoritative: true
    })
    // Why: live activity clears the authoritative flag; a busy named agent
    // must not be reaped by a Stop that (as always) omits its lifecycle id.
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 150)
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(true)
  })

  it('removes fold-recreated one-shots missing from a later present list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'a9' })], 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.has('a9')).toBe(false)
  })

  it('matches teammate ids by name only up to the hyphen-free suffix', () => {
    expect(claudeTeammateIdMatchesName('aprobe1-6d3cb5b5', 'probe1')).toBe(true)
    expect(claudeTeammateIdMatchesName('alane-hooks-6d3cb5b5', 'lane-hooks')).toBe(true)
    expect(claudeTeammateIdMatchesName('alane-hooks-6d3cb5b5', 'lane')).toBe(false)
    expect(claudeTeammateIdMatchesName('aprobe1-6d3cb5b5', 'probe')).toBe(false)
    expect(claudeTeammateIdMatchesName('aprobe1', 'probe1')).toBe(false)
  })

  it('parks teammates idle by the name embedded in agent_id and confirms them', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    upsertWorkingClaudeSubagent(roster, 'aother-123', { agentType: 'other' }, 100)

    // Why: TeammateIdle means "turn over, awaiting mail" on 2.1.21x — the row
    // parks as a confirmed teammate instead of leaving the sidebar.
    expect(idleClaudeTeammateByName(roster, 'probe1')).toBe(true)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({
      state: 'idle',
      confirmedTeammate: true
    })
    expect(roster.get('aother-123')).toMatchObject({ state: 'working' })
    // Repeat/unknown idles are no-ops so lifecycle refreshes don't churn.
    expect(idleClaudeTeammateByName(roster, 'probe1')).toBe(false)
    expect(idleClaudeTeammateByName(roster, 'ghost')).toBe(false)
  })

  it('does not idle an unrelated one-shot whose agent_type matches the teammate name', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Why: a teammate's start hook may be missing (restart, cap, or lost
    // delivery). Agent type is not identity, so its idle hook must not park
    // another live child that happens to use the same type name.
    upsertWorkingClaudeSubagent(roster, 'aoneshot00000001', { agentType: 'reviewer' }, 100)

    expect(idleClaudeTeammateByName(roster, 'reviewer')).toBe(false)
    expect(roster.get('aoneshot00000001')).toMatchObject({ state: 'working' })
  })

  it('keeps a confirmed idle teammate through folds that list teammate tasks', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    stopClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    idleClaudeTeammateByName(roster, 'probe1')
    // Why: the parked teammate is alive between turns; while the inventory
    // still shows teammate-typed tasks its idle row must survive lead Stops.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'tprobe1', teammate: true })], 200)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'idle' })

    // A complete inventory with no teammate-typed task proves it is gone.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'aunrelated0000001' })], 300)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(false)
  })

  it('reaps an unconfirmed idle teammate-shaped row at the next complete fold', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // A finished workflow lane wears a teammate-shaped id but never receives
    // a TeammateIdle; only its SubagentStop arrives.
    upsertWorkingClaudeSubagent(roster, 'alane-hooks-6d3cb5b5', { agentType: 'lane-hooks' }, 100)
    stopClaudeSubagent(roster, 'alane-hooks-6d3cb5b5')
    expect(roster.get('alane-hooks-6d3cb5b5')).toMatchObject({ state: 'idle' })

    // Why: without the TeammateIdle confirmation the idle row is a finished
    // lane — surviving folds would rebuild the pre-#8825 idle pile.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'tteam1', teammate: true })], 200)
    expect(roster.has('alane-hooks-6d3cb5b5')).toBe(false)
  })

  it('serializes snapshots deterministically ordered by startedAt then id', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'b', {}, 200)
    upsertWorkingClaudeSubagent(roster, 'z', {}, 100)
    upsertWorkingClaudeSubagent(roster, 'aidle-6d3cb5b5', {}, 100)
    stopClaudeSubagent(roster, 'aidle-6d3cb5b5')
    const snapshots = claudeRosterToSnapshots(roster)
    expect(snapshots?.map((s) => s.id)).toEqual(['aidle-6d3cb5b5', 'z', 'b'])
    // Why: idle rows serialize their parked state so the sidebar renders them.
    expect(snapshots?.map((s) => s.state)).toEqual(['idle', 'working', 'working'])
    expect(claudeRosterToSnapshots(new Map())).toBeUndefined()
  })
})
