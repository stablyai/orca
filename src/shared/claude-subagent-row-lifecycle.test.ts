/**
 * Regression spec for the two reported sidebar symptoms (live-reproduced in a
 * dev instance before the fix):
 *
 *  1. "Really long idle list" under ultracode/orchestration: finished
 *     subagents left permanent `Idle - <type>` child rows for the rest of the
 *     session — including named/workflow agents, whose background_tasks
 *     entries report `type: "teammate"` and never stop reading "running"
 *     (captured live on 2.1.210). Fixed: the roster tracks ONLY working
 *     children; SubagentStop (and its TeammateIdle fallback) removes a
 *     finished child outright, so no idle rows can accumulate.
 *
 *  2. "Never disappear even when killed from Orca": a subagent killed without
 *     its SubagentStop hook (SIGKILL'd process tree / lost event) stayed
 *     `working` forever and pinned the pane working. Fixed: a lead Stop's
 *     background_tasks reaps unlisted children — hyphen-free one-shots always,
 *     and teammate-shaped rows once a complete inventory shows no
 *     teammate-typed task at all.
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

  it('removes finished named agents on SubagentStop even while their teammate task stays "running"', () => {
    // Exact shape captured live (claude 2.1.210): named background agents get
    // teammate-shaped ids (a<name>-<hex>) AND appear in background_tasks as
    // `type: "teammate"` entries (unrelated ids) that report "running"
    // forever — even after the agent finished. Pre-fix these squatted as
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

    // web-research finishes. Its SubagentStop still lists both teammate tasks
    // as "running", but the finished row must leave immediately.
    const afterFirst = claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'aweb-research-8a76b7d7595ce04e',
      background_tasks: teammateTasks
    })
    expect(afterFirst?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'aoss-hunt-95a28c160dc99e5e', state: 'working' })
    ])

    // oss-hunt finishes too — roster empties and the pane resolves done, even
    // though background_tasks STILL reports both teammate tasks running.
    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aoss-hunt-95a28c160dc99e5e' })
    const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: teammateTasks })
    expect(finalStop?.payload.state).toBe('done')
    expect(finalStop?.payload.subagents).toBeUndefined()
  })

  it('reaps a named agent via its TeammateIdle fallback when SubagentStop is lost', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestration (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'areview-standards-2750dacd',
      agent_type: 'review-standards'
    })

    // No SubagentStop arrives (lost/interrupt race), but claude still emits
    // TeammateIdle keyed by name once the agent goes idle — the row must go.
    const idled = claudeEvent({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'review-standards',
      team_name: 'orchestration'
    })
    expect(idled?.payload.subagents).toBeUndefined()

    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'tstd', type: 'teammate', status: 'running' }]
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.subagents).toBeUndefined()
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
