/**
 * Regression spec for the two reported sidebar symptoms (live-reproduced in a
 * dev instance before the fix):
 *
 *  1. "Really long idle list" under ultracode: finished workflow subagents
 *     left permanent `Idle - general-purpose` child rows for the rest of the
 *     session. Fixed: SubagentStop removes a one-shot subagent from the
 *     roster; only alive-but-idle teammates keep an idle row.
 *
 *  2. "Never disappear even when killed from Orca": a subagent killed without
 *     its SubagentStop hook (SIGKILL'd process tree / lost event) stayed
 *     `working` forever and pinned the pane working. Fixed: a lead Stop's
 *     background_tasks is authoritative for non-teammate children — running
 *     ones are always listed id-exact (verified against live hook captures),
 *     so an unlisted non-teammate is finished/dead and is removed.
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

  it('keeps an alive-but-idle teammate row while dropping finished one-shots', () => {
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'teams session' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'areviewer-6d3cb5b52120b7bf',
      agent_type: 'security-reviewer'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'aoneshot000000001',
      agent_type: 'general-purpose'
    })

    claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aoneshot000000001' })
    claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'areviewer-6d3cb5b52120b7bf',
      agent_type: 'security-reviewer'
    })
    const idled = claudeEvent({
      hook_event_name: 'TeammateIdle',
      teammate_name: 'reviewer',
      team_name: 'session-repro'
    })
    // Teammate stays (alive + resumable); the finished one-shot is gone.
    expect(idled?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areviewer-6d3cb5b52120b7bf', state: 'idle' })
    ])

    // Teams Stops list teammate tasks under unrelated ids and never send an
    // empty list; the teammate row must survive them.
    const stop = claudeEvent({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'tlkjjs0jv', type: 'teammate', status: 'running' }]
    })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'areviewer-6d3cb5b52120b7bf', state: 'idle' })
    ])
  })

  it('drops named workflow lanes instead of retaining them as phantom idle teammates', () => {
    // Regression for the live-observed 32-row pile: workflow lanes report
    // name-embedding ids (afinder-C-<hex>, agent_type = the label), which
    // share the teammate id shape but are one-shots.
    claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'native chat review (ultracode)' })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'afinder-C-5d713c0781b7f8d2',
      agent_type: 'finder-C'
    })
    claudeEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'acr-triage-1-c5a0588e7a2e4151',
      agent_type: 'cr-triage-1'
    })

    // finder-C finishes; its SubagentStop carries the task inventory that
    // lists it id-exact as a subagent — proof it is not a teammate.
    const stopped = claudeEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'afinder-C-5d713c0781b7f8d2',
      agent_type: 'finder-C',
      background_tasks: [
        {
          id: 'afinder-C-5d713c0781b7f8d2',
          type: 'subagent',
          status: 'running',
          agent_type: 'finder-C'
        },
        {
          id: 'acr-triage-1-c5a0588e7a2e4151',
          type: 'subagent',
          status: 'running',
          agent_type: 'cr-triage-1'
        }
      ]
    })
    expect(stopped?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'acr-triage-1-c5a0588e7a2e4151', state: 'working' })
    ])

    // cr-triage-1 is killed (SubagentStop lost). The lead Stop's complete
    // inventory lists no teammate-typed task, so the leftover is removed.
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
