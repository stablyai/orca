import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, normalizeHookPayload } from './agent-hook-listener'
import { makePaneKey } from './stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
let state: ReturnType<typeof createHookListenerState>

function codexEvent(payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')
}

function withBlockedChild() {
  codexEvent({ hook_event_name: 'SessionStart' })
  codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'explore' })
  codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'child-1' })
}

// Why: the roster reap and the effective-state read must stay in this order. Swapping them
// breaks one of the two contracts below, and each was a shipped bug at some point (#4375).
describe('Codex lead state vs. a live subagent roster', () => {
  beforeEach(() => {
    state = createHookListenerState()
  })

  // Every lead event that normalizes to `working` must yield to a blocked child, not just the
  // PostToolUse this originally regressed on.
  it.each([
    ['PostToolUse', { hook_event_name: 'PostToolUse', tool_name: 'read' }],
    ['PreToolUse', { hook_event_name: 'PreToolUse', tool_name: 'read' }],
    ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'keep going' }]
  ])('holds the pane at waiting on a lead %s while a child is blocked', (_name, event) => {
    withBlockedChild()
    // Read pre-reap: a lead that keeps working must not paper over a child's permission prompt,
    // or the pane looks busy and the user never sees what it is blocked on.
    expect(codexEvent(event)?.payload.state).toBe('waiting')
  })

  it('still reports done on a lead Stop, flagging that children were live', () => {
    withBlockedChild()
    const stopped = codexEvent({ hook_event_name: 'Stop' })
    // Read post-reap: agent-hooks/server.ts retires child rows on a root Stop and reports 'done'.
    // The pre-reap flag carries the "children were live" signal instead of downgrading the state.
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.leadStopWithLiveSubagents).toBe(true)
  })

  it('omits the flag on a lead Stop with no live children', () => {
    codexEvent({ hook_event_name: 'SessionStart' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'explore' })
    codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    const stopped = codexEvent({ hook_event_name: 'Stop' })
    expect(stopped?.payload.state).toBe('done')
    expect(stopped?.payload.leadStopWithLiveSubagents).toBeUndefined()
  })

  // The gate suppresses on roster membership, so a child whose Stop hook never arrives (Codex
  // 0.144 drops them) costs a real completion. These two pin how far that can go: the Stop reap
  // empties the roster, so the cost is exactly ONE turn and the next turn notifies unaided.
  // That measured bound is why there is no aging/liveness timer here — any release window short
  // enough to salvage the dropped-hook turn is shorter than a legitimately long-running child,
  // and would re-fire the very spam #4375 reports.
  it('flags only the turn a dropped child Stop spans, not the next one', () => {
    codexEvent({ hook_event_name: 'SessionStart' })
    codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'turn one' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'explore' })
    // child-1's SubagentStop is dropped by the CLI and never arrives.
    expect(codexEvent({ hook_event_name: 'Stop' })?.payload.leadStopWithLiveSubagents).toBe(true)

    codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'turn two' })
    const turnTwo = codexEvent({ hook_event_name: 'Stop' })
    expect(turnTwo?.payload.state).toBe('done')
    expect(turnTwo?.payload.leadStopWithLiveSubagents).toBeUndefined()
  })

  it('clears the flag as soon as the child does report, so nothing is stranded', () => {
    codexEvent({ hook_event_name: 'SessionStart' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'explore' })
    expect(codexEvent({ hook_event_name: 'Stop' })?.payload.leadStopWithLiveSubagents).toBe(true)
    // The child's own Stop carries the turn end the gated lead Stop withheld: deferred, not lost.
    const childStop = codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'child-1' })
    expect(childStop?.payload.state).toBe('done')
    expect(childStop?.payload.leadStopWithLiveSubagents).toBeUndefined()
  })
})
