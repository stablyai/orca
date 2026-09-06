// Render-time projection of a turn's accumulated RPC state into the overlay
// messages NativeChat splices in — split from the reducer's own state-machine
// tests exactly as the modules are (omp-rpc-turn-overlay.ts vs
// omp-rpc-turn-reducer.ts): everything here asserts on
// `selectOmpRpcOverlayMessages`, which needs a transcript the reducer never sees.

import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import {
  OMP_RPC_OVERLAY_ASSISTANT_ID,
  OMP_RPC_OVERLAY_REASONING_ID,
  OMP_RPC_RECAP_ID_PREFIX,
  OMP_RPC_SUBAGENT_ROSTER_ID,
  selectOmpRpcOverlayMessages
} from './omp-rpc-turn-overlay'

function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

function reduceAll(events: OmpRpcClientEvent[]): OmpRpcTurnState {
  return events.reduce(
    (state, event) => ompRpcTurnReducer(state, frame(event)),
    createInitialOmpRpcTurnState()
  )
}

const transcriptAssistant = (text: string): NativeChatMessage => ({
  id: 't-1',
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

const transcriptReasoning = (text: string): NativeChatMessage => ({
  id: 't-reasoning-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text }],
  timestamp: null,
  source: 'transcript'
})

// XLR-007: the list re-sorts on the rendered clock and reads a null timestamp
// as negative infinity, so the append position the integration chose is only
// honored if the overlay sorts as the live tail it is.
describe('selectOmpRpcOverlayMessages list order', () => {
  it('keeps the overlay at the tail of a timestamped transcript, in emitted order', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }
      },
      {
        kind: 'subagent-lifecycle',
        frame: {
          type: 'subagent_lifecycle',
          payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started', detached: true }
        }
      }
    ])
    const transcript: NativeChatMessage[] = [
      {
        id: 'disk-1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        timestamp: 1_000,
        source: 'transcript'
      },
      {
        id: 'disk-2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }],
        timestamp: 2_000,
        source: 'transcript'
      }
    ]
    const overlay = selectOmpRpcOverlayMessages(state, transcript)
    expect(overlay.map((message) => message.id)).toEqual([
      OMP_RPC_OVERLAY_REASONING_ID,
      OMP_RPC_OVERLAY_ASSISTANT_ID,
      OMP_RPC_SUBAGENT_ROSTER_ID
    ])

    const ordered = orderNativeChatMessages([...transcript, ...overlay])

    expect(ordered.map((message) => message.id)).toEqual([
      'disk-1',
      'disk-2',
      OMP_RPC_OVERLAY_REASONING_ID,
      OMP_RPC_OVERLAY_ASSISTANT_ID,
      OMP_RPC_SUBAGENT_ROSTER_ID
    ])
  })
})

describe('selectOmpRpcOverlayMessages', () => {
  it('shows the assistant overlay while working and the transcript has not caught up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Working on it' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      source: 'rpc'
    })
  })

  it('drops the overlay once the transcript already contains the same text', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello there')])
    expect(messages).toEqual([])
  })

  // W6-1 (CRITICAL, third-lab review q2): a terminal agent_end must not blank
  // the just-finished reply. RPC's agent_end arrives over an already-open
  // stdout pipe with no debounce, while the transcript update goes through a
  // 150ms filesystem-watcher debounce plus IPC plus a re-render — so gating
  // overlay visibility on the binary `working` flag flickered the reply off
  // and back on. The overlay must persist until the transcript demonstrably
  // covers it, whether or not the turn is still working.
  it('keeps rendering the reply after a terminal agent_end until the transcript catches up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: OMP_RPC_OVERLAY_ASSISTANT_ID,
      role: 'assistant',
      source: 'rpc'
    })
  })

  it('drops the overlay once the transcript catches up after a terminal agent_end', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    expect(selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello there')])).toEqual([])
  })

  it('keeps rendering reasoning after a terminal agent_end until the transcript catches up', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages.map((m) => m.id)).toEqual([OMP_RPC_OVERLAY_REASONING_ID])
  })

  // Root cause (wave 12): the reasoning overlay was gated by comparing its
  // thinking prose against the transcript's assistant prose, which never
  // matches — the overlay leaked past its turn (rendered after the answer,
  // never retired). It must retire against the transcript's own
  // `role: 'reasoning'` row (wave-7 decoder output) instead.
  it('retires the reasoning overlay once the transcript carries a matching reasoning row', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [
      transcriptReasoning('thinking hard about it'),
      transcriptAssistant('answer')
    ]
    const messages = selectOmpRpcOverlayMessages(state, transcript)
    expect(messages.map((m) => m.id)).not.toContain(OMP_RPC_OVERLAY_REASONING_ID)
  })

  // Wave 6 anti-flicker preserved: a settled assistant answer alone (no
  // reasoning row yet) must not retire the reasoning overlay — the
  // transcript tailer may still be catching up on the reasoning row
  // specifically, even though the answer already landed.
  it('keeps the reasoning overlay when the transcript has the answer but no reasoning row yet', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'answer' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('answer')])
    expect(messages.map((m) => m.id)).toContain(OMP_RPC_OVERLAY_REASONING_ID)
  })

  // D4: once the transcript fully covers a settled turn (both its reasoning
  // row and its answer), no overlay message may render — the visible order
  // comes from the transcript rows alone.
  it('renders zero overlay messages once the transcript fully covers a settled turn', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'answer' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [
      transcriptReasoning('thinking hard about it'),
      transcriptAssistant('the full answer')
    ]
    expect(selectOmpRpcOverlayMessages(state, transcript)).toEqual([])
  })

  // D4: reasoning renders exactly once for a settled turn — the transcript's
  // row once it lands, never the overlay's stale copy alongside it.
  it('never double-renders reasoning once the transcript carries it', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking hard' }
        }
      },
      { kind: 'agent-end', frame: { type: 'agent_end' } }
    ])
    const transcript = [transcriptReasoning('thinking hard'), transcriptAssistant('answer')]
    const overlayIds = selectOmpRpcOverlayMessages(state, transcript).map((m) => m.id)
    const reasoningOccurrences = overlayIds.filter(
      (id) => id === OMP_RPC_OVERLAY_REASONING_ID
    ).length
    expect(reasoningOccurrences).toBe(0)
  })

  it('shows a reasoning overlay ahead of the reply overlay', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
        }
      },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'reply' }
        }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages.map((m) => m.id)).toEqual([
      OMP_RPC_OVERLAY_REASONING_ID,
      OMP_RPC_OVERLAY_ASSISTANT_ID
    ])
  })

  it('shows a tool-call overlay even with no text yet, while working', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }
      }
    ])
    const messages = selectOmpRpcOverlayMessages(state, [])
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-call', name: 'read', input: {}, toolCallId: 'c1' }
    ])
  })

  // F8 (MEDIUM): a tool-first turn (empty assistantText) whose tool entry the
  // transcript tailer already surfaced must render it exactly once, not
  // duplicated between the overlay and the transcript.
  it('suppresses an overlay tool block once the transcript already carries its toolCallId', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }
      },
      {
        kind: 'tool-execution-end',
        frame: { type: 'tool_execution_end', toolCallId: 'c1' },
        output: 'done',
        isError: false
      }
    ])
    // Both transcript rows, as the decoder writes them: the call rides the
    // assistant message, the result its own tool message
    // (transcript-line-decoders-omp.ts).
    const transcript: NativeChatMessage[] = [
      {
        id: 't-call',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'read', input: {}, toolCallId: 'c1' }],
        timestamp: null,
        source: 'transcript'
      },
      {
        id: 't-tool',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'done', toolCallId: 'c1' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    expect(selectOmpRpcOverlayMessages(state, transcript)).toEqual([])
  })

  // SESP-003: the two transcript rows for one call land separately, so a
  // persisted tool-call is coverage of the CALL only. Treating it as coverage
  // of the result too blanks the live partial output until the tailer catches
  // up — a visible gap in the ordinary file-versus-RPC race.
  it('keeps the live tool result while the transcript carries only the tool call', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} }
      },
      {
        kind: 'tool-execution-update',
        frame: { type: 'tool_execution_update', toolCallId: 'c1' },
        partialOutput: 'first line'
      }
    ])
    const transcript: NativeChatMessage[] = [
      {
        id: 't-call',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'bash', input: {}, toolCallId: 'c1' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const messages = selectOmpRpcOverlayMessages(state, transcript)
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-result', output: 'first line', isError: false, toolCallId: 'c1' }
    ])
  })

  it('keeps the tool call visible while the transcript carries only the result', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} }
      }
    ])
    const transcript: NativeChatMessage[] = [
      {
        id: 't-tool',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'done', toolCallId: 'c1' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const messages = selectOmpRpcOverlayMessages(state, transcript)
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: {}, toolCallId: 'c1' }
    ])
  })

  // F8: a text-length tie against the transcript must hide only the text
  // block, never the in-flight tool blocks the transcript hasn't caught up to.
  it('keeps in-flight tool blocks visible on a text-length tie with the transcript', () => {
    const state = reduceAll([
      { kind: 'agent-start', frame: { type: 'agent_start' } },
      {
        kind: 'message-update',
        frame: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
        }
      },
      {
        kind: 'tool-execution-start',
        frame: { type: 'tool_execution_start', toolCallId: 'c2', toolName: 'read', args: {} }
      }
    ])
    // Tie: transcript's last assistant text is exactly as long as the overlay's.
    const messages = selectOmpRpcOverlayMessages(state, [transcriptAssistant('Hello')])
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'tool-call', name: 'read', input: {}, toolCallId: 'c2' }
    ])
  })
})

describe('OMP RPC idle recap rendering', () => {
  it('renders the current recap as a distinct RPC system row', () => {
    const recap = {
      text: 'Mapped the RPC surface. Next: close the history gap.',
      trigger: 'idle' as const,
      timestamp: 1234
    }
    const state = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({ kind: 'recap-update', recap })
    )

    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([
      {
        id: `${OMP_RPC_RECAP_ID_PREFIX}1234`,
        role: 'system',
        blocks: [{ type: 'text', text: `※ recap: ${recap.text}` }],
        timestamp: 1234,
        source: 'rpc'
      }
    ])
  })

  it('removes the recap when OMP invalidates it or starts a new turn', () => {
    const withRecap = ompRpcTurnReducer(
      createInitialOmpRpcTurnState(),
      frame({
        kind: 'recap-update',
        recap: { text: 'Old recap', trigger: 'idle', timestamp: 1234 }
      })
    )

    expect(
      ompRpcTurnReducer(withRecap, frame({ kind: 'recap-update', recap: null })).latestRecap
    ).toBeNull()
    expect(
      ompRpcTurnReducer(withRecap, frame({ kind: 'agent-start', frame: { type: 'agent_start' } }))
        .latestRecap
    ).toBeNull()
  })
})
