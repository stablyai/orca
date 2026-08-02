/**
 * Regression spec for the three reported sidebar symptoms (each
 * live-reproduced before its fix):
 *
 *  1. "Really long idle list" under ultracode/orchestration: finished
 *     subagents left permanent `Idle - <type>` child rows for the rest of the
 *     session — including named/workflow agents, whose background_tasks
 *     entries report `type: "teammate"` and never stop reading "running"
 *     (captured live on 2.1.210). Fixed: one-shot SubagentStop removes the
 *     row outright, and idle teammate-shaped rows survive lead-Stop folds
 *     only when a TeammateIdle confirmed a live teammate owns the id.
 *
 *  2. "Never disappear even when killed from Orca": a subagent killed without
 *     its SubagentStop hook (SIGKILL'd process tree / lost event) stayed
 *     `working` forever and pinned the pane working. Fixed: a lead Stop's
 *     background_tasks reaps unlisted children — hyphen-free one-shots always,
 *     and teammate-shaped rows once a complete inventory shows no
 *     teammate-typed task at all.
 *
 *  3. "Sidebar never shows my subagents" on claude 2.1.21x: in-process
 *     teammates are turn-based — SubagentStop + TeammateIdle fire at every
 *     TURN end while the teammate stays alive awaiting mail (verified live on
 *     2.1.217) — so remove-on-stop hid them for all but their brief working
 *     bursts. Fixed: teammate rows park as idle (never gating the pane
 *     'working') and revive via the next SubagentStart.
 *
 * Drives the real production pipeline (normalizeHookPayload) whose
 * `payload.subagents` snapshots the sidebar renders 1:1 as child rows.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  normalizeHookPayload,
  type HookListenerState
} from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

describe('claude subagent sidebar row lifecycle', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const claudeEvent = (payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> =>
    normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')

  it('drops each finished workflow subagent instead of accumulating idle rows', () => {
    claudeEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Help me research Vercel sandbox usage (ultracode)'
    })

    // A Workflow run spawns 21 one-shot agents over a long turn; each stops
    // shortly after starting. Pre-fix this accumulated 21 idle rows.
    let last: ReturnType<typeof claudeEvent>
    for (let i = 0; i < 21; i++) {
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: `awf0000000000000${String(i).padStart(2, '0')}`,
        agent_type: 'general-purpose'
      })
      last = claudeEvent({
        hook_event_name: 'SubagentStop',
        agent_id: `awf0000000000000${String(i).padStart(2, '0')}`
      })
      expect(last?.payload.subagents).toBeUndefined()
    }

    // Concurrent agents still show while working.
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aworking0000000001',
      agent_type: 'general-purpose'
    })
    const working = claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aworking0000000002',
      agent_type: 'general-purpose'
    })
    expect(working?.payload.subagents).toHaveLength(2)
    expect(working?.payload.state).toBe('working')
  })

  it('removes a killed subagent whose SubagentStop was never delivered at the next lead Stop', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'research task' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'akilled0000000001',
      agent_type: 'general-purpose'
    })

    // The child is killed; no SubagentStop ever arrives. The next lead Stop
    // lists everything still alive — the killed child is not in it.
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        {
          id: 'aother00000000001',
          type: 'subagent',
          status: 'running',
          agent_type: 'general-purpose'
        }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aother00000000001', state: 'working' })
    ])
    // The pane stays working only for the child that is genuinely alive.
    expect(stop?.payload.state).toBe('working')

    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aother00000000001' })
    const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
    expect(finalStop?.payload.state).toBe('done')
    expect(finalStop?.payload.subagents).toBeUndefined()
  })

  it('reaps stopped never-idle-confirmed named lanes at the lead Stop, not on their own stop', () => {
    // Exact shape captured live (claude 2.1.210): named background agents get
    // teammate-shaped ids (a<name>-<hex>) AND appear in background_tasks as
    // `type: "teammate"` entries (unrelated ids) that report "running"
    // forever — even after the agent finished. Pre-#8825 these squatted as
    // permanent idle rows (the 11-row gar "Orchestration Messages" pile).
    claudeEvent({
      hook_event_name: 'UserPromptSubmit',
      prompt: '--- Orchestration Messages (1) --- (ultracode)'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aweb-research-8a76b7d7595ce04e',
      agent_type: 'web-research'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aoss-hunt-95a28c160dc99e5e',
      agent_type: 'oss-hunt'
    })

    // The lead's turn ends while both are still working — the pane must not
    // read done, and the two rows show as working.
    const teammateTasks = [
      { id: 'tws2g167l', type: 'teammate', status: 'running', description: 'web research' },
      { id: 't6s2brfv7', type: 'teammate', status: 'running', description: 'oss hunt' }
    ]
    const midStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(midStop?.payload.state).toBe('working')
    expect(midStop?.payload.subagents).toHaveLength(2)

    // web-research stops. On 2.1.21x that may be a mere turn boundary, so the
    // row parks as idle — visible but no longer gating the pane.
    const afterFirst = claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'aweb-research-8a76b7d7595ce04e',
      background_tasks: teammateTasks
    })
    expect(afterFirst?.payload.subagents).toHaveLength(2)
    expect(afterFirst?.payload.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'aoss-hunt-95a28c160dc99e5e', state: 'working' }),
        expect.objectContaining({ id: 'aweb-research-8a76b7d7595ce04e', state: 'idle' })
      ])
    )

    // oss-hunt stops too. No TeammateIdle ever confirmed either id as a live
    // teammate, so the next complete fold reaps both parked rows — the pane
    // resolves done with no idle pile, even though background_tasks STILL
    // reports both teammate tasks running.
    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aoss-hunt-95a28c160dc99e5e' })
    const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(finalStop?.payload.state).toBe('done')
    expect(finalStop?.payload.subagents).toBeUndefined()
  })

  it('parks a TeammateIdle-confirmed teammate as a persistent idle row without gating done', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestration (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'areview-standards-2750dacd',
      agent_type: 'review-standards'
    })

    // TeammateIdle = "turn over, awaiting mail" (verified live on 2.1.217).
    // The row parks as idle instead of leaving — this is the reported
    // "sidebar never shows my subagents" regression.
    const idled = claudeEvent({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'review-standards',
      team_name: 'orchestration'
    })
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areview-standards-2750dacd', state: 'idle' })
    ])

    // The confirmed idle row survives lead Stops that still list teammate
    // tasks, and never pins the pane working.
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'tstd', type: 'teammate', status: 'running' }]
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areview-standards-2750dacd', state: 'idle' })
    ])

    // A complete inventory with no teammate-typed task left proves the
    // teammate is gone — only then does the parked row leave.
    const teardown = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
    expect(teardown?.payload.state).toBe('done')
    expect(teardown?.payload.subagents).toBeUndefined()
  })

  it('keeps a turn-based teammate visible across its work/idle cycle and revives it on resume', () => {
    // The reported repro (claude 2.1.217): a named Explore teammate does a
    // ~50s turn, idles awaiting mail, is resumed via SendMessage, then idles
    // again — pre-fix the sidebar showed it only during the brief bursts.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'map the polling pipeline' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      agent_type: 'poll-map'
    })
    const teammateTasks = [{ id: 'ta5jpcars', type: 'teammate', status: 'running' }]

    // Turn ends: SubagentStop then TeammateIdle (order captured live).
    claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      background_tasks: teammateTasks
    })
    const idled = claudeEvent({ hook_event_name: 'TeammateIdle', teammate_name: 'poll-map' })
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'idle' })
    ])

    // The lead keeps working, then its turn ends — the parked row survives.
    const leadStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(leadStop?.payload.state).toBe('done')
    expect(leadStop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'idle' })
    ])

    // SendMessage wakes the teammate: same lifecycle id, row revives working
    // and gates the (done) pane back to working.
    const revived = claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'apoll-map-74e71b7bd45975f7',
      agent_type: 'poll-map'
    })
    expect(revived?.payload.state).toBe('working')
    expect(revived?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'apoll-map-74e71b7bd45975f7', state: 'working' })
    ])
  })

  it('reaps a killed named agent at the lead Stop when no teammate task remains', () => {
    // A named agent dies with neither SubagentStop nor TeammateIdle. Its
    // teammate-shaped id never appears as a task id, so it can only be reaped
    // when a complete inventory shows no teammate-typed task at all.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestration (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'acr-triage-1-c5a0588e7a2e4151',
      agent_type: 'cr-triage-1'
    })

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [
        {
          id: 'awf0000000000000zz',
          type: 'subagent',
          status: 'running',
          agent_type: 'general-purpose'
        }
      ]
    })
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'awf0000000000000zz', state: 'working' })
    ])
  })

  it('removes aborted subagents on the interrupt Stop so the pane can resolve', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'long batch' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aaborted000000001',
      agent_type: 'general-purpose'
    })

    // Esc/Ctrl+C: claude emits SubagentStop for aborted children (verified
    // live), then Stop with is_interrupt. Both paths clean the roster.
    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aaborted000000001' })
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      is_interrupt: true,
      background_tasks: []
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.interrupted).toBe(true)
    expect(stop?.payload.subagents).toBeUndefined()
  })
})
