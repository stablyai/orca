import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentHookSource } from './agent-hook-relay'
import { AGENT_DESCENDANT_QUIET_REAP_MS } from './agent-descendant-roster'

/** Every case drives `normalizeHookPayload`, the entry both the main process and the relay
 *  call, so a fix that never reaches production wiring cannot pass here. */
describe('descendant lifecycle never settles the pane', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const publish = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeAndAccept> => normalizeAndAccept(state, source, payload)

  const publishedState = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): string | undefined => publish(source, payload)?.payload.state

  describe('grok nested subagents (STA-6982)', () => {
    const startTurn = (): void => {
      expect(publishedState('grok', { hookEventName: 'UserPromptSubmit', prompt: 'ship it' })).toBe(
        'working'
      )
    }

    it('keeps the pane working when a nested child session ends', () => {
      startTurn()
      // Why: grok remaps a child's turn gate to SubagentStop, so the child's own SessionEnd is what
      // reaches the parent's pane. It carries subagentType; the session's own SessionEnd never does.
      expect(
        publishedState('grok', {
          hookEventName: 'SessionEnd',
          reason: 'clear',
          subagentType: 'explore'
        })
      ).toBe('working')
    })

    it('keeps the pane working when a nested child turn fails', () => {
      startTurn()
      expect(
        publishedState('grok', {
          hookEventName: 'StopFailure',
          error: 'rate_limit',
          subagentType: 'explore'
        })
      ).toBe('working')
    })

    it('still settles the pane on the lead session own stop', () => {
      startTurn()
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('done')
    })

    it('holds the pane working while a tracked child outlives the lead turn', () => {
      startTurn()
      const spawned = publish('grok', {
        hookEventName: 'SubagentStart',
        subagentId: 'sub-1',
        subagentType: 'explore',
        description: 'review the diff'
      })
      expect(spawned?.payload.state).toBe('working')
      expect(spawned?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'sub-1', state: 'working', agentType: 'explore' })
      ])

      // The lead's own Stop is real, but a live child means the pane is not idle yet.
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      const drained = publish('grok', {
        hookEventName: 'SubagentStop',
        subagentId: 'sub-1',
        subagentType: 'explore'
      })
      expect(drained?.payload.state).toBe('done')
      expect(drained?.payload.subagents).toBeUndefined()
    })

    it('publishes exactly one done across a child-then-lead completion', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      const states = [
        publishedState('grok', { hookEventName: 'SessionEnd', reason: 'clear', subagentType: 'x' }),
        publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' }),
        publishedState('grok', {
          hookEventName: 'SubagentStop',
          subagentId: 'sub-1',
          subagentType: 'x'
        })
      ]
      expect(states).toEqual(['working', 'working', 'done'])
      expect(states.filter((value) => value === 'done')).toHaveLength(1)
    })

    it('does not relabel the pane with a child tool call', () => {
      startTurn()
      const parentTool = publish('grok', {
        hookEventName: 'PreToolUse',
        toolName: 'edit_file',
        toolInput: { path: 'src/app.ts' }
      })
      expect(parentTool?.payload.toolName).toBe('edit_file')

      const childTool = publish('grok', {
        hookEventName: 'PreToolUse',
        subagentType: 'explore',
        subagentId: 'sub-1',
        toolName: 'run_terminal_cmd',
        toolInput: { command: 'rg TODO' }
      })
      expect(childTool?.payload.state).toBe('working')
      expect(childTool?.payload.toolName).toBe('edit_file')
      expect(childTool?.payload.prompt).toBe('ship it')
      expect(childTool?.hasExplicitPrompt).toBeUndefined()
    })

    it('clears children when the lead turn is interrupted before its stop gate runs', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      // Why: an interrupted turn skips the stop gate, so the child never reports a finish and
      // this cancel is the only proof it is gone. Without it the pane never settles again.
      const cancelled = publish('grok', {
        hookEventName: 'StopCancelled',
        reason: 'user_interrupt',
        cancelledBy: 'user'
      })
      // Why: assert what the PANE shows, not what the roster holds. Clearing the roster while
      // publishing nothing leaves the renderer on the pre-cancel row — spinner still running,
      // child still listed — which is exactly the shape a roster-only assertion cannot see.
      expect(cancelled).not.toBeNull()
      expect(cancelled?.payload.state).toBe('done')
      expect(cancelled?.payload.subagents).toBeUndefined()
      // Why: a cancelled turn did not finish; the flag is what makes the row read 'Interrupted'
      // and any notification say 'stopped' rather than 'finished'.
      expect(cancelled?.payload.interrupted).toBe(true)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('settles a runtime-cancelled turn without waiting for an idle ping', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      const cancelled = publish('grok', {
        hookEventName: 'StopCancelled',
        reason: 'max_turns',
        cancelledBy: 'runtime'
      })
      expect(cancelled?.payload.state).toBe('done')
      expect(cancelled?.payload.interrupted).toBe(true)
      expect(cancelled?.payload.subagents).toBeUndefined()
    })

    it('surfaces a child blocked on a human answer', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      // Why: grok auto-allows ask_user_question, so the child announces its wait as a PreToolUse.
      // Routing child events away from the lead normalizer must not swallow it.
      const asked = publish('grok', {
        hookEventName: 'PreToolUse',
        subagentType: 'x',
        subagentId: 'sub-1',
        toolName: 'ask_user_question',
        toolInput: { question: 'which one?' }
      })
      expect(asked?.payload.state).toBe('waiting')

      // The pane keeps waiting while the lead's own turn ends underneath it.
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('waiting')
    })

    it('keeps siblings alive when one child cancels itself', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-2', subagentType: 'x' })
      publish('grok', {
        hookEventName: 'StopCancelled',
        reason: 'max_turns',
        cancelledBy: 'runtime',
        subagentType: 'x',
        subagentId: 'sub-1'
      })
      expect(state.descendantRosterByPaneKey.get(PANE_KEY)?.size).toBe(1)
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')
    })

    it('reaps a child whose finish never arrived instead of pinning the pane forever', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      const tracked = state.descendantRosterByPaneKey.get(PANE_KEY)?.get('sub-1')
      expect(tracked).toBeDefined()
      // Why: every provider loses a stop hook sometimes (disabled, untrusted, timed out, killed).
      // A claim nothing can retract must not outlive the quiet window.
      tracked!.lastEventAt = Date.now() - AGENT_DESCENDANT_QUIET_REAP_MS - 1

      expect(
        publishedState('grok', {
          hookEventName: 'Notification',
          notificationType: 'idle_prompt',
          message: 'Type your message'
        })
      ).toBe('done')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('drops a stale child roster when the pane starts a new agent process', () => {
      startTurn()
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('working')

      // Why: a child whose stop hook was lost must not pin the pane forever; a replaced agent
      // process cannot still have the old process's children.
      publish('grok', { hookEventName: 'SessionStart', source: 'startup' })
      expect(publishedState('grok', { hookEventName: 'UserPromptSubmit', prompt: 'again' })).toBe(
        'working'
      )
      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('done')
    })
  })

  describe('pi async subagent runs (STA-6378)', () => {
    const startTurn = (): void => {
      expect(
        publishedState('pi', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      ).toBe('working')
      expect(publishedState('pi', { hook_event_name: 'agent_start' })).toBe('working')
    }

    it('settles the pane when the parent ends with no async children', () => {
      startTurn()
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })

    it('stays working when the parent settles while an async child run continues', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(started?.payload.state).toBe('working')
      expect(started?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'run-1', state: 'working', agentType: 'researcher' })
      ])

      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      const finished = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: []
      })
      expect(finished?.payload.state).toBe('done')
      expect(finished?.payload.subagents).toBeUndefined()
    })

    it('completes once when the final child wakes the parent for another turn', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }, { id: 'run-2' }]
      })

      const states = [
        publishedState('pi', { hook_event_name: 'agent_end' }),
        publishedState('pi', {
          hook_event_name: 'subagent_async_state',
          subagent_runs: [{ id: 'run-2' }]
        }),
        // The last child wakes the parent, which runs another turn before the pane is idle.
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] }),
        publishedState('pi', { hook_event_name: 'agent_start' }),
        publishedState('pi', { hook_event_name: 'agent_end' })
      ]
      expect(states).toEqual(['working', 'working', 'done', 'working', 'done'])
    })

    it('repairs a dropped intermediate set from the next one', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }, { id: 'run-2' }, { id: 'run-3' }]
      })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      // Why: the extension transport coalesces, so the sets naming run-2 and run-3 as still
      // live can be dropped entirely. The surviving newest message alone must settle the pane.
      expect(
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBe('done')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('keeps the parent prompt while an async child reports', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }],
        prompt: 'child task text'
      })
      expect(started?.payload.prompt).toBe('delegate')
      expect(started?.hasExplicitPrompt).toBeUndefined()
    })
  })

  describe('pane-scoped state bookkeeping', () => {
    it('reports a descendant-only pane as holding a state claim', () => {
      publish('grok', { hookEventName: 'UserPromptSubmit', prompt: 'go' })
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(true)

      clearPaneCacheState(state, PANE_KEY)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('does not claim a state for a pane that only cached a lead verdict', () => {
      publish('grok', { hookEventName: 'UserPromptSubmit', prompt: 'go' })
      publish('grok', { hookEventName: 'Stop', reason: 'end_turn' })
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(true)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)

      // Why: the lead cache only refines a republish an incoming child event already
      // triggered; it never creates a row. With the pane's stored row gone it is the
      // only descendant state left, and it must not read as a live claim on its own.
      state.lastStatusByPaneKey.delete(PANE_KEY)
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(false)
    })

    it('moves descendant state with the pane when its key is remapped', () => {
      publish('grok', { hookEventName: 'UserPromptSubmit', prompt: 'go' })
      publish('grok', { hookEventName: 'SubagentStart', subagentId: 'sub-1', subagentType: 'x' })

      movePaneCacheState(state, PANE_KEY, 'tab-2:22222222-2222-4222-8222-222222222222')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(
        state.descendantRosterByPaneKey.get('tab-2:22222222-2222-4222-8222-222222222222')?.size
      ).toBe(1)
    })
  })
})
