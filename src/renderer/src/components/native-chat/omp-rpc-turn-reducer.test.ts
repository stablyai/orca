import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES } from './omp-rpc-overlay-retention'
import {
  createInitialOmpRpcTurnState,
  isOmpRpcTurnActive,
  ompRpcTurnReducer,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
import { OMP_RPC_SUBAGENT_ROSTER_ID, selectOmpRpcOverlayMessages } from './omp-rpc-turn-overlay'

function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

function reduceAll(events: OmpRpcClientEvent[]): OmpRpcTurnState {
  return events.reduce(
    (state, event) => ompRpcTurnReducer(state, frame(event)),
    createInitialOmpRpcTurnState()
  )
}

describe('ompRpcTurnReducer', () => {
  it('starts idle with no overlay content', () => {
    const state = createInitialOmpRpcTurnState()
    expect(state.status).toBe('idle')
    expect(isOmpRpcTurnActive(state)).toBe(false)
  })

  it('flips to working on agent_start and accumulates text deltas into one block', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hel' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'lo' }
        }
      }
    ])
    expect(state.status).toBe('working')
    expect(state.assistantText).toBe('Hello')
    expect(state.blocks).toEqual([{ type: 'text', text: 'Hello' }])
    expect(isOmpRpcTurnActive(state)).toBe(true)
  })

  it('interleaves tool-call and tool-result blocks with surrounding text in order', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Checking...' }
        }
      },
      {
        kind: 'tool-execution-start',
        frame: {
          type: 'tool_execution_start',
          toolCallId: 'c1',
          toolName: 'read',
          args: { path: 'a' }
        }
      },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1' },
        output: 'file body',
        isError: false
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Done.' }
        }
      }
    ])
    expect(state.blocks).toEqual([
      { type: 'text', text: 'Checking...' },
      { type: 'tool-call', name: 'read', input: { path: 'a' }, toolCallId: 'c1' },
      { type: 'tool-result', output: 'file body', isError: false, toolCallId: 'c1' },
      { type: 'text', text: 'Done.' }
    ])
  })

  it('accumulates thinking deltas separately from reply text', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'Pondering' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Answer' }
        }
      }
    ])
    expect(state.reasoningText).toBe('Pondering')
    expect(state.assistantText).toBe('Answer')
  })

  it('resets accumulated content on a fresh agent_start (new turn)', () => {
    const first = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'first turn' }
        }
      }
    ])
    const second = ompRpcTurnReducer(
      first,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )
    expect(second.assistantText).toBe('')
    expect(second.blocks).toEqual([])
    expect(second.status).toBe('working')
  })

  it('stays working when agent_end reports isTerminal:false (maintenance continues)', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      { kind: 'agent-end', frame: { type: 'agent_end', isTerminal: false } }
    ])
    expect(state.status).toBe('working')
  })

  it('flips to idle on a terminal agent_end (absent isTerminal counts as terminal)', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(state.status).toBe('idle')
  })

  // F1 (CRITICAL): OMP echoes the user's own turn through message_update with
  // role:'user' and no assistantMessageEvent at all — this must never fault.
  it('treats a message_update with no assistantMessageEvent as a valid non-fatal user echo', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: { type: 'message_update', message: { role: 'user' } }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }
      }
    ])
    expect(state.status).toBe('working')
    expect(state.assistantText).toBe('reply')
  })

  // F2 (CRITICAL): isOmpRpcTurnActive must be a lifecycle fact (status alone),
  // not content-derived — otherwise every completed turn stays "active" forever.
  it('isOmpRpcTurnActive returns false once a turn completes, even though content survives for the leads compare', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hi there' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(state.status).toBe('idle')
    expect(state.assistantText).toBe('hi there')
    expect(isOmpRpcTurnActive(state)).toBe(false)
  })

  // F3 (HIGH): a dead transport can no longer be "working" — protocol-fault
  // and exit must clear the working status even though the reducer itself
  // stays a no-op for anything else (the session hook owns the D1 fallback).
  it('clears working status on protocol-fault and exit', () => {
    const faulted = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
        }
      },
      { kind: 'protocol-fault', message: 'boom' }
    ])
    expect(faulted.status).toBe('idle')
    expect(isOmpRpcTurnActive(faulted)).toBe(false)

    const exited = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' }
        }
      },
      { kind: 'exit', code: 1, signal: null }
    ])
    expect(exited.status).toBe('idle')
    expect(isOmpRpcTurnActive(exited)).toBe(false)
  })

  // F11 (MEDIUM): a single tool result must not grow renderer state unbounded.
  it('caps a single tool-result output at a byte budget', () => {
    const huge = 'x'.repeat(200_000)
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1' },
        output: huge,
        isError: false
      }
    ])
    const result = state.blocks.find((b) => b.type === 'tool-result')
    expect(result?.type).toBe('tool-result')
    if (result?.type === 'tool-result') {
      expect(result.output.length).toBeLessThan(huge.length)
      expect(result.output).toContain('truncated')
    }
  })

  // A detached spawn keeps running after the parent turn ends, so the turn
  // boundary that rebuilds the overlay must not orphan it: dropping the row
  // would make every later progress frame arrive for an unknown id and the
  // still-running subagent would vanish for good.
  it('carries a still-running detached subagent across a turn boundary', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started', detached: true }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } },
      { kind: 'agent-start', frame: { type: 'agent_start' } }
    ])
    expect(state.subagents.map((entry) => entry.id)).toEqual(['sa-1'])
    const advanced = ompRpcTurnReducer(
      state,
      frame({
        kind: 'subagent-progress',
        frame: {
          type: 'subagent_progress',
          payload: {
            index: 0,
            agent: 'explorer',
            task: 'watch the build',
            detached: true,
            progress: {
              id: 'sa-1',
              index: 0,
              agent: 'explorer',
              status: 'running',
              task: 'watch the build',
              currentTool: 'bash'
            }
          }
        }
      })
    )
    expect(advanced.subagents[0].currentTool).toBe('bash')
  })

  it('drops an attached subagent and a finished detached one at a turn boundary', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-attached', index: 0, agent: 'explorer', status: 'started' }
        }
      },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-done', index: 1, agent: 'reviewer', status: 'started', detached: true }
        }
      },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: {
            id: 'sa-done',
            index: 1,
            agent: 'reviewer',
            status: 'completed',
            detached: true
          }
        }
      },
      { kind: 'agent-start', frame: { type: 'agent_start' } }
    ])
    expect(state.subagents).toEqual([])
  })

  // The event stream is the only place a child's own work shows up: progress
  // aggregates status, never what the subagent is saying or running right now.
  it('projects a forwarded subagent event onto the roster row', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started' }
        }
      },
      {
        kind: 'subagent-event',
        frame: {
          type: 'subagent_event',
          payload: {
            id: 'sa-1',
            event: {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'mapping the auth flow' }
            }
          }
        }
      }
    ])
    expect(state.subagents[0].latestText).toBe('mapping the auth flow')
    const roster = selectOmpRpcOverlayMessages(state, []).find(
      (message) => message.id === OMP_RPC_SUBAGENT_ROSTER_ID
    )
    expect(roster?.blocks[0]).toEqual({
      type: 'text',
      text: '※ subagents\n· explorer — running · mapping the auth flow'
    })
  })
})

describe('extension-ui request queueing', () => {
  it('sets the first select/confirm/input request as pending', () => {
    const state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: {
          type: 'extension_ui_request',
          id: 'ask-1',
          method: 'select',
          options: ['Approve', 'Deny']
        }
      })
    )
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-1')
  })

  it('queues a second request behind the pending one', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-2', method: 'confirm' }
      })
    )
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-1')
    expect(state.queuedExtensionUiRequests.map((r) => r.id)).toEqual(['ask-2'])
  })

  it('promotes the next queued request once the pending one is answered', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-2', method: 'confirm' }
      })
    )
    state = ompRpcTurnReducer(state, { type: 'extension-ui-answered', requestId: 'ask-1' })
    expect(state.pendingExtensionUiRequest?.id).toBe('ask-2')
    expect(state.queuedExtensionUiRequests).toEqual([])
  })

  it('dismisses the pending request on a cancel-method frame with the same id', () => {
    let state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'select', options: ['Yes'] }
      })
    )
    state = ompRpcTurnReducer(
      state,
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-1', method: 'cancel' }
      })
    )
    expect(state.pendingExtensionUiRequest).toBeNull()
  })

  it('ignores notify/setStatus/setWidget methods (log-and-ignore scope)', () => {
    const state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: {
          type: 'extension_ui_request',
          id: 'w-1',
          method: 'setWidget',
          widgetKey: 'autoresearch'
        }
      })
    )
    expect(state.pendingExtensionUiRequest).toBeNull()
    expect(state.queuedExtensionUiRequests).toEqual([])
  })

  // F6 (HIGH): a select with no non-empty options renders zero buttons — the
  // reducer must not promote it to pendingExtensionUiRequest (it would wedge
  // the pane, since the composer is unmounted while a request is pending).
  it('never promotes a select request with absent or empty options', () => {
    const absentOptions = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-empty-1', method: 'select' }
      })
    )
    expect(absentOptions.pendingExtensionUiRequest).toBeNull()

    const emptyOptions = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'extension-ui-request',
        frame: { type: 'extension_ui_request', id: 'ask-empty-2', method: 'select', options: [] }
      })
    )
    expect(emptyOptions.pendingExtensionUiRequest).toBeNull()
  })
})

describe('history hydration', () => {
  const hydrated = (id: string, text: string): NativeChatMessage => ({
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'rpc'
  })

  it('starts with no hydrated history', () => {
    expect(createInitialOmpRpcTurnState().hydratedHistory).toBeNull()
  })

  it('records the drained snapshot', () => {
    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    expect(state.hydratedHistory).toEqual({
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1,
      coversWholeSession: true,
      sessionId: null
    })
  })

  it('replaces rather than appends a re-hydration, since each drain is a whole snapshot', () => {
    // A partial walk can never be spliced onto a later one (see
    // drainOmpRpcHistory) — the same rule applies one layer up.
    const first = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'a'), hydrated('omp-rpc-history-1', 'b')],
      totalMessages: 2
    })
    const second = ompRpcTurnReducer(first, {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'a')],
      totalMessages: 1
    })

    expect(second.hydratedHistory).toEqual({
      messages: [hydrated('omp-rpc-history-0', 'a')],
      totalMessages: 1,
      coversWholeSession: true,
      sessionId: null
    })
  })

  it('survives a turn, so a streamed reply does not discard the hydrated history', () => {
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    const afterTurn = [
      { kind: 'agent-start' as const, frame: { type: 'agent_start' as const } },
      { kind: 'agent-end' as const, frame: { type: 'agent_end' as const } }
    ].reduce((state, event) => ompRpcTurnReducer(state, frame(event)), hydratedState)

    expect(afterTurn.hydratedHistory?.messages).toEqual(hydratedState.hydratedHistory?.messages)
    expect(afterTurn.hydratedHistory?.totalMessages).toBe(1)
  })

  it('is dropped by a session reset, which rebinds the pane to another session', () => {
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    expect(ompRpcTurnReducer(hydratedState, { type: 'reset' }).hydratedHistory).toBeNull()
  })

  it('keeps only the most recent messages when a huge session is drained', () => {
    // Bounded like every other retained field in this reducer (F11). The head
    // is what gets dropped, matching the transcript read's own tail window.
    const messages = Array.from({ length: OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES + 5 }, (_, index) =>
      hydrated(`omp-rpc-history-${index}`, `m${index}`)
    )

    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages,
      totalMessages: messages.length
    })

    expect(state.hydratedHistory?.messages).toHaveLength(OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES)
    expect(state.hydratedHistory?.messages[0]?.id).toBe('omp-rpc-history-5')
    // totalMessages stays the wire truth, so a reader still knows the drain
    // was complete even though the retained window is smaller.
    expect(state.hydratedHistory?.totalMessages).toBe(messages.length)
  })

  it('reports a capped snapshot as NOT covering the session', () => {
    // The drain was whole but the retained window is not, and the flag reports
    // that rather than mere presence: the dropped head is reachable only
    // through the transcript window.
    const messages = Array.from({ length: OMP_RPC_HYDRATED_HISTORY_MAX_MESSAGES + 5 }, (_, index) =>
      hydrated(`omp-rpc-history-${index}`, `m${index}`)
    )

    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages,
      totalMessages: messages.length
    })

    expect(state.hydratedHistory?.coversWholeSession).toBe(false)
  })

  it('reports an uncapped snapshot as covering the session', () => {
    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    expect(state.hydratedHistory?.coversWholeSession).toBe(true)
  })

  it('retires the coverage claim once a turn starts under the snapshot', () => {
    // Coverage is a claim about the SESSION as drained, not about the array: a
    // turn that starts afterwards appends records the snapshot never saw, so
    // the claim cannot outlive the drain.
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })
    expect(hydratedState.hydratedHistory?.coversWholeSession).toBe(true)

    const afterTurnStart = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )

    expect(afterTurnStart.hydratedHistory?.coversWholeSession).toBe(false)
    // Only the claim expires — the drained records are still real history.
    expect(afterTurnStart.hydratedHistory?.messages).toEqual(
      hydratedState.hydratedHistory?.messages
    )
    expect(afterTurnStart.hydratedHistory?.totalMessages).toBe(1)
  })

  it('retires the coverage claim for a turn that arrives without agent_start', () => {
    // OMP echoes the user's own turn as a message_update carrying no
    // assistantMessageEvent, with no agent_start ahead of it; that echo is
    // still a session record the snapshot does not contain.
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    const afterEcho = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'message-update', frame: { type: 'message_update' } })
    )

    expect(afterEcho.hydratedHistory?.coversWholeSession).toBe(false)
  })

  it('leaves a coverage claim alone while the session only reports on itself', () => {
    // config_update/session_info_update describe the session, they do not add
    // to it — expiring on those would withdraw the claim for nothing.
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'reply')],
      totalMessages: 1
    })

    const afterInfo = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'session-info', title: 'renamed', sessionId: 'session-1' })
    )

    expect(afterInfo.hydratedHistory?.coversWholeSession).toBe(true)
  })

  it('drops hydrated history when session-info identifies a different session', () => {
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'old reply')],
      totalMessages: 1
    })
    const namedOldSession = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'session-info', title: 'old', sessionId: 'session-a' })
    )

    const switched = ompRpcTurnReducer(
      namedOldSession,
      frame({ kind: 'session-info', title: 'new', sessionId: 'session-b' })
    )

    expect(switched.sessionInfo).toEqual({ title: 'new', sessionId: 'session-b' })
    expect(switched.hydratedHistory).toBeNull()
    expect(switched.observedSessionGrowth).toBe(false)
  })

  it('drops hydrated history when the FIRST published identity is already a switch', () => {
    // XLR-025: the owning session publishes no identity at acquisition, so a
    // command that moves the child makes main's synthesized `session-info` the
    // first identity event this pane ever sees. Requiring an already-published
    // id before invalidating kept session A's snapshot while the pane repointed
    // its transcript at B — and the merge then folded A's records into B.
    const hydratedState = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'from session a')],
      totalMessages: 1,
      sessionId: 'session-a'
    })

    const switched = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'session-info', title: null, sessionId: 'session-b' })
    )

    expect(switched.hydratedHistory).toBeNull()
    expect(switched.observedSessionGrowth).toBe(false)
    expect(switched.sessionInfo).toEqual({ title: null, sessionId: 'session-b' })
    // The same first frame naming the session it drained under is a
    // self-report, not a switch: the snapshot stays.
    const named = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'session-info', title: 'a', sessionId: 'session-a' })
    )
    expect(named.hydratedHistory?.messages).toEqual(hydratedState.hydratedHistory?.messages)
    // Nor is an id-less frame a switch: it names no session, so it repoints
    // nothing and may not cost the pane history nothing re-drains.
    const renamed = ompRpcTurnReducer(
      hydratedState,
      frame({ kind: 'session-info', title: 'renamed', sessionId: null })
    )
    expect(renamed.hydratedHistory?.messages).toEqual(hydratedState.hydratedHistory?.messages)
  })

  it('retains a published identity when a later title-only frame omits it', () => {
    const onSessionB = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({ kind: 'session-info', title: 'b', sessionId: 'session-b' })
    )

    const renamed = ompRpcTurnReducer(
      onSessionB,
      frame({ kind: 'session-info', title: 'renamed', sessionId: null })
    )

    expect(renamed.sessionInfo).toEqual({ title: 'renamed', sessionId: 'session-b' })
  })

  it('treats the ownership identity as the bound session before history hydrates', () => {
    const switched = ompRpcTurnReducer(
      ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
        type: 'session-identity-bound',
        sessionId: 'session-a'
      }),
      frame({ kind: 'session-info', title: 'b', sessionId: 'session-b' }),
    )

    expect(switched.assistantText).toBe('')
    expect(switched.sessionInfo).toEqual({ title: 'b', sessionId: 'session-b' })
  })

  // XLR-032: the acquisition generation cannot fence this — a command that
  // switches the SAME acquired child never changes it — so a drain started
  // under A can still land after B was published.
  it('refuses a snapshot whose drain identity is no longer the published session', () => {
    const onSessionB = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({ kind: 'session-info', title: null, sessionId: 'session-b' })
    )

    const late = ompRpcTurnReducer(onSessionB, {
      type: 'history-hydrated',
      messages: [hydrated('omp-rpc-history-0', 'from session a')],
      totalMessages: 1,
      sessionId: 'session-a'
    })

    expect(late.hydratedHistory).toBeNull()
    // A drain that names the published session, or names none at all, still
    // lands: an unnamed drain proves nothing either way.
    expect(
      ompRpcTurnReducer(onSessionB, {
        type: 'history-hydrated',
        messages: [hydrated('omp-rpc-history-0', 'from session b')],
        totalMessages: 1,
        sessionId: 'session-b'
      }).hydratedHistory?.messages
    ).toHaveLength(1)
    expect(
      ompRpcTurnReducer(onSessionB, {
        type: 'history-hydrated',
        messages: [hydrated('omp-rpc-history-0', 'unnamed')],
        totalMessages: 1
      }).hydratedHistory?.messages
    ).toHaveLength(1)
  })

  // XLR-033: a proven switch is a different conversation, so every projection
  // of the old one goes with the snapshot — not just the snapshot.
  it('retires every projection of the session it switched away from', () => {
    const onSessionA = [
      frame({ kind: 'session-info', title: 'a', sessionId: 'session-a' }),
      frame({ kind: 'commands', commands: [{ name: 'branch' }] }),
      frame({ kind: 'config-update', model: { id: 'model-a' }, thinkingLevel: 'high' }),
      frame({
        kind: 'recap-update',
        recap: { text: 'session a recap', trigger: 'idle', timestamp: 1 }
      }),
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } }),
      frame({
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'session a reply' }
        }
      })
    ].reduce((state, action) => ompRpcTurnReducer(state, action), createInitialOmpRpcTurnState())
    expect(onSessionA.assistantText).toContain('session a reply')

    const switched = ompRpcTurnReducer(
      onSessionA,
      frame({ kind: 'session-info', title: null, sessionId: 'session-b' })
    )

    expect(switched.sessionInfo).toEqual({ title: null, sessionId: 'session-b' })
    expect(switched.assistantText).toBe('')
    expect(switched.reasoningText).toBe('')
    expect(switched.blocks).toEqual([])
    expect(switched.availableCommands).toEqual([{ name: 'branch' }])
    expect(switched.config).toBeNull()
    expect(switched.latestRecap).toBeNull()
    expect(switched.subagents).toEqual([])
    expect(switched.advisorCards).toEqual([])
    expect(switched.retiredAdvisorTurnIds).toEqual([])
    expect(switched.hydratedHistory).toBeNull()
    expect(switched.observedSessionGrowth).toBe(false)
  })

  it('keeps the catalog OMP published for a switched session before its identity readback', () => {
    const onSessionA = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({ kind: 'session-info', title: 'a', sessionId: 'session-a' })
    )
    const withSessionBCommands = ompRpcTurnReducer(
      onSessionA,
      frame({ kind: 'commands', commands: [{ name: 'resume' }, { name: 'new' }] })
    )

    const switched = ompRpcTurnReducer(
      withSessionBCommands,
      frame({ kind: 'session-info', title: 'b', sessionId: 'session-b' })
    )

    expect(switched.availableCommands).toEqual([{ name: 'resume' }, { name: 'new' }])
  })

  // The command that CAUSED the switch still owns the capture slot: its output
  // and its pending `prompt_result` are not projections of the old session.
  it('carries the in-flight command capture across a proven switch', () => {
    const dispatched = ompRpcTurnReducer(
      ompRpcTurnReducer(
        createInitialOmpRpcTurnState(),
        frame({ kind: 'session-info', title: 'a', sessionId: 'session-a' })
      ),
      { type: 'command-dispatched', commandRunId: 'run-1' }
    )
    const withOutput = ompRpcTurnReducer(
      dispatched,
      frame({ kind: 'command-output', text: 'switched to session b' })
    )

    const switched = ompRpcTurnReducer(
      withOutput,
      frame({ kind: 'session-info', title: null, sessionId: 'session-b' })
    )

    expect(switched.commandRunId).toBe('run-1')
    expect(switched.commandOutputText).toBe('switched to session b')
  })

  it('refuses a coverage claim when the session already grew before the drain landed', () => {
    // Nothing orders the frame subscription against the independent history
    // invocation, so the growth frame can land while `hydratedHistory` is still
    // null and leave no claim to expire. Growth has to latch, or the late
    // snapshot restores a claim the session already outgrew and pagination
    // stays withdrawn over records nothing can reach. A reset clears the latch,
    // since it rebinds the pane to another session.
    const grown = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )
    const hydrate = {
      type: 'history-hydrated' as const,
      messages: [hydrated('h-0', 'reply')],
      totalMessages: 1
    }

    expect(ompRpcTurnReducer(grown, hydrate).hydratedHistory?.coversWholeSession).toBe(false)
    expect(
      ompRpcTurnReducer(ompRpcTurnReducer(grown, { type: 'reset' }), hydrate).hydratedHistory
        ?.coversWholeSession
    ).toBe(true)
  })
})
