import { describe, expect, it } from 'vitest'
import { readClaudeBackgroundAgentTasks } from './claude-background-task-inventory'
import {
  claudeRosterHasRuntimeWorkingSubagent,
  claudeRosterHasWorkingSubagent,
  claudeRosterToSnapshots,
  claudeTeammateIdMatchesName,
  foldClaudeBackgroundTasksIntoRoster,
  idleClaudeTeammateByName,
  reapUnconfirmedRestoredClaudeSubagents,
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

    // Remove finished one-shots to avoid accumulating dead Idle rows.
    stopClaudeSubagent(roster, 'a1')
    expect(roster.size).toBe(0)
    expect(claudeRosterToSnapshots(roster)).toBeUndefined()
  })

  it('parks a teammate-shaped named agent as idle on stop', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Claude 2.1.21x teammates emit SubagentStop per turn while alive; keep them idle without gating pane work.
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
    // An id-exact subagent task proves a workflow lane; its stop is final.
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

    // Inventory and lifecycle hooks can race; authoritative running tasks retain the working gate.
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

  it('keeps 40 working subagents', () => {
    const roster: ClaudeSubagentRoster = new Map()
    for (let i = 0; i < 40; i++) {
      upsertWorkingClaudeSubagent(roster, `a${i}`, {}, i)
    }
    expect(claudeRosterToSnapshots(roster)).toHaveLength(40)
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

  it('trusts id-exact subagent matches and ignores teammate-typed entries', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    // A named agent mid-run: teammate-shaped id, never a task id.
    upsertWorkingClaudeSubagent(roster, 'ateam-6d3cb5b5', { agentType: 'security-reviewer' }, 150)

    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        task({ id: 'a1', agentType: 'general-purpose', description: 'review loop' }),
        // Teammate task IDs differ from lifecycle IDs; do not create phantom duplicates.
        task({ id: 'tlkjjs0jv', description: 'teammate task', teammate: true })
      ],
      200
    )

    expect(roster.size).toBe(2)
    expect(roster.get('a1')).toMatchObject({ description: 'review loop' })
    // Teammate presence makes lifecycle-ID omission inconclusive.
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
    // One-shots are listed id-exact; omission proves a lost finish even while other teammates remain.
    upsertWorkingClaudeSubagent(roster, 'akilled0000000001', { agentType: 'general-purpose' }, 100)
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.size).toBe(0)
  })

  it('keeps a live named agent whose teammate-typed id never appears in the list', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Named lifecycle IDs are omitted from teammate task inventories; do not finish their working rows early.
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
    // No teammate-typed task in a complete inventory proves the named child’s lost stop.
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
    foldClaudeBackgroundTasksIntoRoster(
      roster,
      [
        task({ id: 'av1-streaming-0b1c2d3e', agentType: 'v1-streaming' }),
        task({ id: 'tteam1', teammate: true })
      ],
      200
    )
    // Id-exact listing overrides teammate-shaped-ID protection on later omission.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'tteam1', teammate: true })], 300)
    expect(roster.has('av1-streaming-0b1c2d3e')).toBe(false)
  })

  it('retains an unlisted live child when the background task inventory was truncated', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'alive-unlisted', {}, 100)
    const parsed = readClaudeBackgroundAgentTasks({
      background_tasks: [
        { id: 'a0', type: 'subagent', status: 'running' },
        { id: 'unreadable', status: 'running' }
      ]
    })

    expect(parsed.truncated).toBe(true)
    foldClaudeBackgroundTasksIntoRoster(roster, parsed.tasks, 200, {
      inventoryComplete: !parsed.truncated
    })
    expect(roster.has('alive-unlisted')).toBe(true)
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
    // Snapshot-seeded entries remain subject to complete-inventory omission even with teammate-shaped IDs.
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
    // Live activity reclaims lifecycle ownership, preventing omission from reaping a busy named teammate.
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

    // Claude 2.1.21x TeammateIdle confirms a live teammate awaiting mail.
    expect(idleClaudeTeammateByName(roster, 'probe1')).toBe(true)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({
      state: 'idle',
      confirmedTeammate: true
    })
    expect(roster.get('aother-123')).toMatchObject({ state: 'working' })
    expect(idleClaudeTeammateByName(roster, 'probe1')).toBe(false)
    expect(idleClaudeTeammateByName(roster, 'ghost')).toBe(false)
  })

  it('does not idle an unrelated one-shot whose agent_type matches the teammate name', () => {
    const roster: ClaudeSubagentRoster = new Map()
    // Without a start hook, type alone cannot identify which live child an idle event belongs to.
    upsertWorkingClaudeSubagent(roster, 'aoneshot00000001', { agentType: 'reviewer' }, 100)

    expect(idleClaudeTeammateByName(roster, 'reviewer')).toBe(false)
    expect(roster.get('aoneshot00000001')).toMatchObject({ state: 'working' })
  })

  it('keeps a confirmed idle teammate through folds that list teammate tasks', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'aprobe1-6d3cb5b5', { agentType: 'probe1' }, 100)
    stopClaudeSubagent(roster, 'aprobe1-6d3cb5b5')
    idleClaudeTeammateByName(roster, 'probe1')
    // Parked confirmed teammates remain alive while inventory still has teammate tasks.
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'tprobe1', teammate: true })], 200)
    expect(roster.get('aprobe1-6d3cb5b5')).toMatchObject({ state: 'idle' })

    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'aunrelated0000001' })], 300)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(false)
  })

  it('reaps an unconfirmed idle teammate-shaped row at the next complete fold', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'alane-hooks-6d3cb5b5', { agentType: 'lane-hooks' }, 100)
    stopClaudeSubagent(roster, 'alane-hooks-6d3cb5b5')
    expect(roster.get('alane-hooks-6d3cb5b5')).toMatchObject({ state: 'idle' })

    // Unconfirmed idle workflow lanes must leave rather than rebuild the #8825 idle pile.
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
    expect(snapshots?.map((s) => s.state)).toEqual(['idle', 'working', 'working'])
    expect(claudeRosterToSnapshots(new Map())).toBeUndefined()
  })
})

describe('restored-row confirmation', () => {
  const restored = (id: string): ClaudeSubagentRoster =>
    new Map([
      [
        id,
        {
          state: 'working' as const,
          startedAt: 100,
          backgroundTasksAuthoritative: true,
          restoredFromSnapshot: true
        }
      ]
    ])

  it('drops a restored row when no agent process is left behind it', () => {
    const roster = restored('areview-loop-c237a4c577493352')
    expect(claudeRosterHasRuntimeWorkingSubagent(roster)).toBe(false)
    expect(reapUnconfirmedRestoredClaudeSubagents(roster)).toBe(true)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(false)
  })

  it('keeps a row a live lifecycle event re-tracked', () => {
    const roster = restored('areview-loop-c237a4c577493352')
    upsertWorkingClaudeSubagent(roster, 'areview-loop-c237a4c577493352', {}, 150)
    expect(claudeRosterHasRuntimeWorkingSubagent(roster)).toBe(true)
    expect(reapUnconfirmedRestoredClaudeSubagents(roster)).toBe(false)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)
  })

  it('keeps a row a live inventory confirmed as running', () => {
    const roster = restored('a9')
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'a9' })], 150)
    expect(reapUnconfirmedRestoredClaudeSubagents(roster)).toBe(false)
    expect(claudeRosterHasWorkingSubagent(roster)).toBe(true)
  })

  it('leaves rows this listener tracked from live events alone', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    expect(reapUnconfirmedRestoredClaudeSubagents(roster)).toBe(false)
    expect(roster.has('a1')).toBe(true)
  })

  it('leaves the inventory reap of a restored row working', () => {
    const roster = restored('aprobe1-6d3cb5b5')
    foldClaudeBackgroundTasksIntoRoster(roster, [task({ id: 'other', teammate: true })], 200)
    expect(roster.has('aprobe1-6d3cb5b5')).toBe(false)
  })
})
