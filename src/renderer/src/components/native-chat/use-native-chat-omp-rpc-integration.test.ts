// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  ompRpcTurnReducer,
  createInitialOmpRpcTurnState,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
import { useNativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'
import {
  OMP_RPC_ADVISOR_ID_PREFIX,
  OMP_RPC_OVERLAY_ASSISTANT_ID,
  OMP_RPC_SUBAGENT_ROSTER_ID
} from './omp-rpc-turn-overlay'

const acquire = vi.fn()
const send = vi.fn()
const abort = vi.fn()
const respondExtensionUi = vi.fn()

const PANE_KEY = 'tab-1:leaf-1'

function seedOwnership(overrides: { isOwned: boolean; turnState: OmpRpcTurnState }): void {
  useAppStore.setState({
    ompRpcChatOwnershipByPaneKey: {
      [PANE_KEY]: {
        status: overrides.isOwned ? 'acquired' : 'live',
        turnState: overrides.turnState,
        generation: overrides.isOwned ? 1 : 0,
        resolvedSessionId: null
      }
    }
  })
}

const transcript = (text: string): NativeChatMessage[] => [
  {
    id: 't-1',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
]

const ARGS = {
  paneKey: PANE_KEY,
  transcriptMessages: [] as NativeChatMessage[],
  hookPreview: undefined as string | null | undefined,
  // Default to the conservative shape: a settled read that reaches the head of
  // the transcript, so nothing may be retired by the window-horizon rule.
  transcriptWindow: { settled: true, omitsOlderRecords: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
  send.mockResolvedValue({ ok: true, agentInvoked: true })
  abort.mockResolvedValue({ ok: true, agentInvoked: true })
  ;(window as unknown as { api: unknown }).api = {
    ompRpcChat: { acquire, send, abort, respondExtensionUi }
  }
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useNativeChatOmpRpcIntegration', () => {
  it('is a no-op when the pane has no ownership row: no overlay, no status override, hook preview passes through', () => {
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, hookPreview: 'typing…' })
    )

    expect(result.current.isRpcOwned).toBe(false)
    expect(result.current.overlayMessages).toEqual([])
    expect(result.current.statusOverride).toBeNull()
    expect(result.current.effectiveHookPreview).toBe('typing…')
    expect(result.current.pendingExtensionUiRequest).toBeNull()
  })

  it('suppresses the hook preview whenever RPC owns the pane, so the two overlays never both render', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, hookPreview: 'stale hook preview' })
    )

    expect(result.current.effectiveHookPreview).toBeNull()
  })

  it('overrides status to working only while the RPC turn is active (D5)', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working' }
    })
    const working = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(working.result.current.statusOverride).toBe('working')
    expect(working.result.current.isRpcTurnWorking).toBe(true)

    // F2 regression: a turn that already completed must not still read as
    // "working" just because its content (assistantText/blocks) survives for
    // the leads-vs-transcript compare — status is the lifecycle fact.
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'idle', assistantText: 'hi there' }
    })
    const postTurn = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(postTurn.result.current.statusOverride).toBeNull()
    expect(postTurn.result.current.isRpcTurnWorking).toBe(false)
  })

  it('never surfaces an overlay message the transcript already covers (D4)', () => {
    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), status: 'working', assistantText: 'done' }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: transcript('done') })
    )

    expect(result.current.overlayMessages).toEqual([])
  })

  it('surfaces the overlay while it leads the transcript', () => {
    seedOwnership({
      isOwned: true,
      turnState: {
        ...createInitialOmpRpcTurnState(),
        status: 'working',
        assistantText: 'a longer in-progress reply',
        blocks: [{ type: 'text', text: 'a longer in-progress reply' }]
      }
    })
    const { result } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: transcript('a longer') })
    )

    expect(result.current.overlayMessages).toHaveLength(1)
    expect(result.current.overlayMessages[0]?.source).toBe('rpc')
  })

  it('surfaces the pending extension UI request only when RPC-owned', () => {
    const request = { type: 'extension_ui_request' as const, id: 'req-1', method: 'confirm' }
    seedOwnership({
      isOwned: false,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toBeNull()

    seedOwnership({
      isOwned: true,
      turnState: { ...createInitialOmpRpcTurnState(), pendingExtensionUiRequest: request }
    })
    expect(
      renderHook(() => useNativeChatOmpRpcIntegration(ARGS)).result.current
        .pendingExtensionUiRequest
    ).toEqual(request)
  })

  it('publishes the session catalog and the wire session identity only while RPC-owned', () => {
    const turnState: OmpRpcTurnState = {
      ...createInitialOmpRpcTurnState(),
      availableCommands: [{ name: 'help' }, { name: 'model', aliases: ['models'] }],
      sessionInfo: { title: 'RPC parity', sessionId: 'sess-wire' }
    }

    seedOwnership({ isOwned: true, turnState })
    const owned = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))

    // The `/` menu needs the descriptions and hints the dispatch-name set drops,
    // so both projections of the same published catalog are exposed.
    expect(owned.result.current.rpcCommands).toEqual(turnState.availableCommands)
    expect([...(owned.result.current.rpcExecutableCommands?.names ?? [])]).toEqual([
      'help',
      'model',
      'models'
    ])
    expect(owned.result.current.sessionTitle).toBe('RPC parity')

    // A pane whose session went away must not keep claiming the old catalog:
    // the session route reads it as proof that the command will execute.
    act(() => seedOwnership({ isOwned: false, turnState }))

    expect(owned.result.current.rpcCommands).toBeNull()
    expect(owned.result.current.rpcExecutableCommands).toBeNull()
    expect(owned.result.current.sessionTitle).toBeNull()
  })

  it('forwards send/abort/respondExtensionUi to the paneKey-scoped store actions', async () => {
    seedOwnership({ isOwned: true, turnState: createInitialOmpRpcTurnState() })
    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))

    await result.current.sendChat({ message: 'hi', behavior: 'idle' })
    await result.current.abortChat()
    act(() => {
      result.current.answerExtensionUi({
        type: 'extension_ui_response',
        id: 'req-1',
        confirmed: true
      })
    })

    expect(send).toHaveBeenCalledWith({ paneKey: PANE_KEY, message: 'hi', behavior: 'idle' })
    expect(abort).toHaveBeenCalledWith({ paneKey: PANE_KEY })
    expect(respondExtensionUi).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      response: { type: 'extension_ui_response', id: 'req-1', confirmed: true }
    })
  })

  // W6-2 regression guard: ownership acquisition lives entirely in the
  // TerminalPane-anchored use-omp-rpc-chat-pane-ownership.ts hook, published
  // into this store slice — this integration hook (mounted inside the
  // remountable NativeChatView) must never itself acquire anything. A
  // remount (an ordinary Terminal<->Chat toggle) performing zero RPC IPC is
  // exactly what makes the toggle instant again.
  it('never acquires anything itself: mount, rerender, and unmount perform zero RPC IPC', () => {
    const { rerender, unmount } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    rerender()
    unmount()

    expect(acquire).not.toHaveBeenCalled()
  })
})

// Phase: session-event projections. These assert the frame -> turn-state ->
// hook path end to end, so a projection that only exists in the reducer's unit
// test cannot pass while the value the view actually reads stays empty.
describe('useNativeChatOmpRpcIntegration session-event projections', () => {
  function reduceFrames(events: Parameters<typeof ompRpcTurnReducer>[1][]): OmpRpcTurnState {
    return events.reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())
  }

  it('renders a subagent roster row from forwarded lifecycle and progress frames', () => {
    const turnState = reduceFrames([
      { type: 'frame', event: { kind: 'agent-start', frame: { type: 'agent_start' } } },
      {
        type: 'frame',
        event: {
          kind: 'subagent-lifecycle',
          frame: {
            type: 'subagent_lifecycle',
            payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started' }
          }
        }
      },
      {
        type: 'frame',
        event: {
          kind: 'subagent-progress',
          frame: {
            type: 'subagent_progress',
            payload: {
              index: 0,
              agent: 'explorer',
              task: 'map the auth flow',
              progress: {
                id: 'sa-1',
                index: 0,
                agent: 'explorer',
                status: 'running',
                task: 'map the auth flow',
                currentTool: 'grep',
                toolCount: 3
              }
            }
          }
        }
      }
    ])
    seedOwnership({ isOwned: true, turnState })

    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    const roster = result.current.overlayMessages.find(
      (message) => message.id === OMP_RPC_SUBAGENT_ROSTER_ID
    )
    expect(roster?.role).toBe('system')
    expect(roster?.blocks).toEqual([
      {
        type: 'text',
        text: '※ subagents\n· explorer — running · map the auth flow · grep (3 tools)'
      }
    ])
  })

  it('renders the canonical tool `args` and `result` payloads in the overlay', () => {
    const turnState = reduceFrames([
      { type: 'frame', event: { kind: 'agent-start', frame: { type: 'agent_start' } } },
      {
        type: 'frame',
        event: {
          kind: 'tool-execution-start',
          frame: {
            type: 'tool_execution_start',
            toolCallId: 'c1',
            toolName: 'bash',
            args: { command: 'ls' }
          }
        }
      },
      {
        type: 'frame',
        event: {
          kind: 'tool-execution-update',
          frame: { type: 'tool_execution_update', toolCallId: 'c1' },
          partialOutput: 'one'
        }
      },
      {
        type: 'frame',
        event: {
          kind: 'tool-execution-end',
          frame: { type: 'tool_execution_end', toolCallId: 'c1' },
          output: 'one\ntwo',
          isError: false
        }
      }
    ])
    seedOwnership({ isOwned: true, turnState })

    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    const overlay = result.current.overlayMessages.find(
      (message) => message.id === OMP_RPC_OVERLAY_ASSISTANT_ID
    )
    // One tool-call row and exactly ONE tool-result row: the update frame
    // streams onto the row its end frame finalizes.
    expect(overlay?.blocks).toEqual([
      { type: 'tool-call', name: 'bash', input: { command: 'ls' }, toolCallId: 'c1' },
      { type: 'tool-result', output: 'one\ntwo', isError: false, toolCallId: 'c1' }
    ])
  })

  it('projects a thinking_level_changed session event onto the pane session config', () => {
    const turnState = reduceFrames([
      {
        type: 'frame',
        event: {
          kind: 'config-update',
          model: { id: 'claude-opus-5', name: 'Opus 5', provider: 'anthropic' },
          thinkingLevel: 'low'
        }
      },
      {
        type: 'frame',
        event: {
          kind: 'session-event',
          frame: { type: 'thinking_level_changed', thinkingLevel: 'xhigh' }
        }
      }
    ])
    seedOwnership({ isOwned: true, turnState })

    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(result.current.sessionConfig).toEqual({
      modelId: 'claude-opus-5',
      modelName: 'Opus 5',
      provider: 'anthropic',
      thinkingLevel: 'xhigh'
    })
  })

  // A level-less frame means "unknown", never "cleared" — the pane must keep
  // showing the level the user really is on.
  it('keeps the last known thinking level when the session event names none', () => {
    const turnState = reduceFrames([
      { type: 'frame', event: { kind: 'config-update', model: null, thinkingLevel: 'high' } },
      {
        type: 'frame',
        event: { kind: 'session-event', frame: { type: 'thinking_level_changed' } }
      }
    ])
    seedOwnership({ isOwned: true, turnState })

    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(result.current.sessionConfig?.thinkingLevel).toBe('high')
  })

  it('clears the roster when the next turn starts', () => {
    const turnState = reduceFrames([
      {
        type: 'frame',
        event: {
          kind: 'subagent-lifecycle',
          frame: {
            type: 'subagent_lifecycle',
            payload: { id: 'sa-1', index: 0, agent: 'explorer', status: 'started' }
          }
        }
      },
      { type: 'frame', event: { kind: 'agent-start', frame: { type: 'agent_start' } } }
    ])
    expect(turnState.subagents).toEqual([])
    seedOwnership({ isOwned: true, turnState })

    const { result } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(
      result.current.overlayMessages.some((message) => message.id === OMP_RPC_SUBAGENT_ROSTER_ID)
    ).toBe(false)
  })
})

// SA-003: the hook is where transcript coverage and the reducer meet, so it is
// the only place that can retire a card for good. Hiding it per render is not
// enough — the transcript window is bounded, and the covering row leaves it.
describe('useNativeChatOmpRpcIntegration advisor card retirement', () => {
  const ADVISOR_TURN_ID = 'omp-advisor:1700000000000:/nit/Stay silent.'
  const advisorCardMessage = {
    role: 'custom',
    customType: 'advisor',
    display: true,
    timestamp: 1_700_000_000_000,
    details: { notes: [{ note: 'Stay silent.', severity: 'nit' }] }
  }

  const coveringTranscript: NativeChatMessage[] = [
    {
      id: 'rec-adv',
      role: 'system',
      blocks: [{ type: 'text', text: '\u203b advisor \u00b7 nit\nStay silent.' }],
      timestamp: 1_700_000_000_000,
      source: 'transcript',
      turnId: ADVISOR_TURN_ID
    }
  ]

  function seedAdvisedPane(): void {
    seedOwnership({
      isOwned: true,
      turnState: ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
        type: 'frame',
        event: {
          kind: 'message-end',
          frame: { type: 'message_end', message: advisorCardMessage }
        }
      })
    })
  }

  const hasAdvisorRow = (messages: readonly NativeChatMessage[]): boolean =>
    messages.some((message) => message.id.startsWith(OMP_RPC_ADVISOR_ID_PREFIX))

  it('retires the card in the store once the transcript covers it', () => {
    seedAdvisedPane()
    const { unmount } = renderHook(() =>
      useNativeChatOmpRpcIntegration({ ...ARGS, transcriptMessages: coveringTranscript })
    )

    const stored = useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.turnState
    expect(stored?.advisorCards).toEqual([])
    expect(stored?.retiredAdvisorTurnIds).toEqual([ADVISOR_TURN_ID])
    unmount()
  })

  it('keeps the retired card hidden after its transcript row leaves the window', () => {
    seedAdvisedPane()
    const { result, rerender, unmount } = renderHook(
      (props: { transcriptMessages: NativeChatMessage[] }) =>
        useNativeChatOmpRpcIntegration({ ...ARGS, ...props }),
      { initialProps: { transcriptMessages: coveringTranscript } }
    )

    act(() => rerender({ transcriptMessages: [] }))
    expect(hasAdvisorRow(result.current.overlayMessages)).toBe(false)
    unmount()
  })

  it('still renders a card the transcript has never covered', () => {
    seedAdvisedPane()
    const { result, unmount } = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))

    expect(hasAdvisorRow(result.current.overlayMessages)).toBe(true)
    expect(
      useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.turnState.advisorCards
    ).toHaveLength(1)
    unmount()
  })

  // SA-005: this retirement runs in an effect in the REMOUNTABLE chat view,
  // while the card lives on pane-anchored RPC ownership that outlives it.
  // Switch to Terminal before the covering row is ever observed and the
  // evidence is missed entirely; reopen after the window has moved on and no
  // turnId left in it can match. Without the window-horizon rule the card
  // comes back as fresh advice on every reopen, forever.
  it('retires a card covered while the view was unmounted, once the window has moved past it', () => {
    seedAdvisedPane()
    // Chat opened, card shown, Chat closed — the covering row never arrived.
    const first = renderHook(() => useNativeChatOmpRpcIntegration(ARGS))
    expect(hasAdvisorRow(first.result.current.overlayMessages)).toBe(true)
    first.unmount()
    expect(
      useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.turnState.advisorCards
    ).toHaveLength(1)

    // Chat reopened much later: every row still in the bounded window is
    // newer than the card, so its own row is behind the window for good.
    const scrolledPastWindow: NativeChatMessage[] = [
      {
        id: 'rec-later',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hundreds of records later' }],
        timestamp: 1_700_000_600_000,
        source: 'transcript'
      }
    ]
    const second = renderHook(() =>
      useNativeChatOmpRpcIntegration({
        ...ARGS,
        transcriptMessages: scrolledPastWindow,
        // The read settled on a window that still drops older records; that is
        // what makes "everything here is newer" mean the card's row is behind
        // the window rather than not yet written.
        transcriptWindow: { settled: true, omitsOlderRecords: true }
      })
    )
    expect(hasAdvisorRow(second.result.current.overlayMessages)).toBe(false)
    const stored = useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.turnState
    expect(stored?.advisorCards).toEqual([])
    expect(stored?.retiredAdvisorTurnIds).toEqual([ADVISOR_TURN_ID])
    second.unmount()
  })

  // SA-007: the same reopen shape against a window that holds the WHOLE
  // transcript is the ordinary race, not a scrolled-past card — message_end
  // beat the tailer to the advisor row while an unrelated later row was
  // already loaded. Retiring there destroys the only copy of the advice.
  it('keeps a card the window cannot have scrolled past', () => {
    seedAdvisedPane()
    const unrelatedLaterRow: NativeChatMessage[] = [
      {
        id: 'rec-later',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'not the advisor entry' }],
        timestamp: 1_700_000_000_001,
        source: 'transcript'
      }
    ]
    const { result, unmount } = renderHook(() =>
      useNativeChatOmpRpcIntegration({
        ...ARGS,
        transcriptMessages: unrelatedLaterRow,
        transcriptWindow: { settled: true, omitsOlderRecords: false }
      })
    )

    expect(hasAdvisorRow(result.current.overlayMessages)).toBe(true)
    const stored = useAppStore.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]?.turnState
    expect(stored?.advisorCards).toHaveLength(1)
    expect(stored?.retiredAdvisorTurnIds).toEqual([])
    unmount()
  })
})
