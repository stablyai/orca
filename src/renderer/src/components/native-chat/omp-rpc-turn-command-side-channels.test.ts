// The command_output / prompt_result / session_info_update / config_update side
// channels: the session-scoped state a slash command routed over the owning RPC
// session produces, split out of omp-rpc-turn-reducer.test.ts to keep both
// files inside the max-lines ratchet.

import { describe, expect, it } from 'vitest'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import {
  createInitialOmpRpcTurnState,
  ompRpcTurnReducer,
  type OmpRpcTurnState
} from './omp-rpc-turn-reducer'
import { OMP_RPC_COMMAND_OUTPUT_ID, selectOmpRpcOverlayMessages } from './omp-rpc-turn-overlay'

function frame(event: OmpRpcClientEvent): { type: 'frame'; event: OmpRpcClientEvent } {
  return { type: 'frame', event }
}

function reduceAll(events: OmpRpcClientEvent[]): OmpRpcTurnState {
  return events.reduce(
    (state, event) => ompRpcTurnReducer(state, frame(event)),
    createInitialOmpRpcTurnState()
  )
}

describe('OMP RPC session-scoped command routing', () => {
  it('renders a local command output as its own RPC system row', () => {
    const state = reduceAll([
      { kind: 'command-output', text: 'Available commands:\n/help\n/model' },
      { kind: 'command-output', text: '\n/usage' },
      { kind: 'prompt-result', agentInvoked: false }
    ])

    expect(state.commandOutputText).toBe('Available commands:\n/help\n/model\n/usage')
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([
      {
        id: OMP_RPC_COMMAND_OUTPUT_ID,
        role: 'system',
        blocks: [{ type: 'text', text: 'Available commands:\n/help\n/model\n/usage' }],
        timestamp: null,
        source: 'rpc'
      }
    ])
  })

  it('clears the previous command output when the next command claims the slot', () => {
    // The command boundary is what retires a capture, not the turn boundary:
    // see the `durable completed command output` block below for why a turn
    // must NOT wipe it. An output whose command started an agent turn is hidden
    // by `commandInvokedAgent` instead of by erasure, so nothing renders twice.
    const withOutput = reduceAll([{ kind: 'command-output', text: 'first' }])

    expect(
      ompRpcTurnReducer(withOutput, { type: 'command-dispatched', commandRunId: 'run-2' })
        .commandOutputText
    ).toBe('')
    expect(ompRpcTurnReducer(withOutput, { type: 'reset' }).commandOutputText).toBe('')
  })

  it('suppresses the captured output from the correlated response alone', () => {
    // A consumed builtin (e.g. /retry) returns agentInvoked on its prompt
    // response and emits NO prompt_result frame, so the response-driven action
    // is the only suppression signal that ever fires for it.
    const dispatched = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'command-dispatched',
      commandRunId: 'run-1'
    })
    const state = ompRpcTurnReducer(
      ompRpcTurnReducer(dispatched, {
        type: 'frame',
        event: { kind: 'command-output', text: 'Retrying the last prompt.' }
      }),
      { type: 'command-agent-invoked', commandRunId: 'run-1' }
    )

    expect(state.commandInvokedAgent).toBe(true)
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })

  it('rearms suppression for the next command dispatched over the session', () => {
    const invoked = ompRpcTurnReducer(
      ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
        type: 'command-dispatched',
        commandRunId: 'run-1'
      }),
      { type: 'command-agent-invoked', commandRunId: 'run-1' }
    )

    expect(
      ompRpcTurnReducer(invoked, { type: 'command-dispatched', commandRunId: 'run-2' })
        .commandInvokedAgent
    ).toBe(false)
  })

  it('ignores a late agent-invoked report from a superseded command run', () => {
    // /retry then /help before /retry settles: /retry's agentInvoked:true lands
    // after /help owns the slot and must not blank /help's captured output.
    const helpRun = ompRpcTurnReducer(
      ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
        type: 'command-dispatched',
        commandRunId: 'retry-run'
      }),
      { type: 'command-dispatched', commandRunId: 'help-run' }
    )
    const withHelpOutput = ompRpcTurnReducer(helpRun, {
      type: 'frame',
      event: { kind: 'command-output', text: 'Available commands:' }
    })

    const stale = ompRpcTurnReducer(withHelpOutput, {
      type: 'command-agent-invoked',
      commandRunId: 'retry-run'
    })

    expect(stale).toBe(withHelpOutput)
    expect(stale.commandInvokedAgent).toBe(false)
    expect(selectOmpRpcOverlayMessages(stale, [])).toHaveLength(1)
  })

  it('ignores an agent-invoked report when no command run owns the slot', () => {
    const state = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'command-agent-invoked',
      commandRunId: 'run-1'
    })

    expect(state.commandInvokedAgent).toBe(false)
  })

  it('records the RPC catalog OMP publishes, the executable-command source of truth', () => {
    const state = reduceAll([
      {
        kind: 'commands',
        commands: [{ name: 'help', description: 'Show available commands' }, { name: 'model' }]
      }
    ])

    expect(state.availableCommands).toEqual([
      { name: 'help', description: 'Show available commands' },
      { name: 'model' }
    ])
  })

  it('keeps the catalog across a turn reset, since it is session-scoped', () => {
    const state = reduceAll([
      { kind: 'commands', commands: [{ name: 'help' }] },
      { kind: 'agent-start', frame: { type: 'agent_start' } }
    ])

    expect(state.availableCommands).toEqual([{ name: 'help' }])
  })

  it('leaves the captured output visible on the prompt_result OMP actually sends', () => {
    // Upstream reports prompt_result ONLY for a local-only prompt, and only
    // with agentInvoked:false (reportLocalOnlyPromptResult returns early when
    // the agent was invoked) — so this frame never suppresses anything. The
    // agent-invoked case arrives on the correlated response instead.
    const state = reduceAll([
      { kind: 'command-output', text: 'Usage for today' },
      { kind: 'prompt-result', id: 'usage-run', agentInvoked: false }
    ])

    expect(state.commandInvokedAgent).toBe(false)
    expect(selectOmpRpcOverlayMessages(state, [])).toHaveLength(1)
  })

  it('lets a local-only prompt_result clear a suppression the response defaulted on', () => {
    // Upstream answers `prompt` for an extension command with no `agentInvoked`
    // data at all (rpc-mode.ts falls through to session.prompt), so the client
    // defaults the flag to true and the response reports agent-invoked. The
    // later prompt_result is the authoritative correction — upstream emits it
    // only when no agent ran — and without it the command's captured output
    // would stay suppressed for good.
    const dispatched = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'command-dispatched',
      commandRunId: 'ext-run'
    })
    const suppressed = [
      { type: 'command-agent-invoked', commandRunId: 'ext-run' } as const,
      frame({ kind: 'command-output', text: 'extension says hello' })
    ].reduce(ompRpcTurnReducer, dispatched)

    expect(selectOmpRpcOverlayMessages(suppressed, [])).toEqual([])

    const corrected = ompRpcTurnReducer(
      suppressed,
      frame({ kind: 'prompt-result', id: 'ext-run', agentInvoked: false })
    )

    expect(corrected.commandInvokedAgent).toBe(false)
    expect(selectOmpRpcOverlayMessages(corrected, [])).toEqual([
      {
        id: OMP_RPC_COMMAND_OUTPUT_ID,
        role: 'system',
        blocks: [{ type: 'text', text: 'extension says hello' }],
        timestamp: null,
        source: 'rpc'
      }
    ])
  })

  it('ignores a local-only prompt_result when no command run owns the slot', () => {
    // A plain chat prompt that turns out local-only also emits this frame; with
    // no command in flight there is nothing for it to correct.
    const state = reduceAll([{ kind: 'prompt-result', id: 'orca-omp-4', agentInvoked: false }])

    expect(state.commandRunId).toBeNull()
    expect(state.commandInvokedAgent).toBe(false)
  })

  it('ignores a prompt_result addressed to a different run than the slot owner', () => {
    // The exact defect this correlation exists for: /deploy (an extension
    // command, so its response omits agentInvoked and the client defaults to
    // suppressing) settles early and frees the send queue; /retry then claims
    // the slot and legitimately suppresses its own output. /deploy's late
    // prompt_result{agentInvoked:false} must not un-suppress /retry.
    const retryRun = [
      { type: 'command-dispatched', commandRunId: 'deploy-run' } as const,
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      { type: 'command-agent-invoked', commandRunId: 'retry-run' } as const,
      frame({ kind: 'command-output', text: 'Retrying the last prompt.' })
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    const stale = ompRpcTurnReducer(
      retryRun,
      frame({ kind: 'prompt-result', id: 'deploy-run', agentInvoked: false })
    )

    expect(stale).toBe(retryRun)
    expect(stale.commandInvokedAgent).toBe(true)
    expect(selectOmpRpcOverlayMessages(stale, [])).toEqual([])
  })

  it('ignores a prompt_result with no id, which correlates with no run', () => {
    const dispatched = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'command-dispatched',
      commandRunId: 'ext-run'
    })
    const suppressed = ompRpcTurnReducer(dispatched, {
      type: 'command-agent-invoked',
      commandRunId: 'ext-run'
    })

    expect(
      ompRpcTurnReducer(suppressed, frame({ kind: 'prompt-result', agentInvoked: false }))
    ).toBe(suppressed)
  })

  it('still honours an agentInvoked prompt_result if the wire ever carries one', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      frame({ kind: 'command-output', text: 'Retrying the last prompt.' }),
      frame({ kind: 'prompt-result', id: 'retry-run', agentInvoked: true })
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandInvokedAgent).toBe(true)
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })

  it('refuses an agentInvoked prompt_result aimed at a superseded run', () => {
    const helpRun = [
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      { type: 'command-dispatched', commandRunId: 'help-run' } as const,
      frame({ kind: 'command-output', text: 'Available commands:' })
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    const stale = ompRpcTurnReducer(
      helpRun,
      frame({ kind: 'prompt-result', id: 'retry-run', agentInvoked: true })
    )

    expect(stale).toBe(helpRun)
    expect(selectOmpRpcOverlayMessages(stale, [])).toHaveLength(1)
  })
})

describe('OMP RPC session_info_update / config_update side channels', () => {
  it('records the session title and id OMP publishes on /rename', () => {
    const state = reduceAll([{ kind: 'session-info', title: 'RPC parity', sessionId: 'sess-1' }])

    expect(state.sessionInfo).toEqual({ title: 'RPC parity', sessionId: 'sess-1' })
  })

  it('records the model and thinking level OMP publishes on /model', () => {
    const state = reduceAll([
      {
        kind: 'config-update',
        model: { id: 'claude-opus-5', name: 'Opus 5', provider: 'anthropic' },
        thinkingLevel: 'high'
      }
    ])

    expect(state.config).toEqual({
      modelId: 'claude-opus-5',
      modelName: 'Opus 5',
      provider: 'anthropic',
      thinkingLevel: 'high'
    })
  })

  it('survives the next turn: these describe the session, not the turn', () => {
    const configured = reduceAll([
      { kind: 'session-info', title: 'RPC parity', sessionId: 'sess-1' },
      { kind: 'config-update', model: { id: 'claude-opus-5' }, thinkingLevel: 'high' }
    ])
    const nextTurn = ompRpcTurnReducer(
      configured,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } })
    )

    expect(nextTurn.sessionInfo).toEqual(configured.sessionInfo)
    expect(nextTurn.config).toEqual(configured.config)
    expect(nextTurn.status).toBe('working')
  })

  it('drops them on an explicit reset — a different session owns the pane then', () => {
    const configured = reduceAll([
      { kind: 'session-info', title: 'RPC parity', sessionId: 'sess-1' },
      { kind: 'config-update', model: { id: 'claude-opus-5' }, thinkingLevel: 'high' }
    ])

    const reset = ompRpcTurnReducer(configured, { type: 'reset' })
    expect(reset.sessionInfo).toBeNull()
    expect(reset.config).toBeNull()
  })

  it('keeps the last known value when OMP publishes a bare frame', () => {
    // A model-less session reports `model: null`; that is "unknown", not
    // "the user just cleared the model", so the last known config stands.
    const configured = reduceAll([
      { kind: 'config-update', model: { id: 'claude-opus-5' }, thinkingLevel: 'high' },
      { kind: 'config-update', model: null, thinkingLevel: null }
    ])

    expect(configured.config).toEqual({
      modelId: 'claude-opus-5',
      modelName: undefined,
      provider: undefined,
      thinkingLevel: 'high'
    })
  })
})

describe('prompt_result authority over the correlated response', () => {
  // The two signals reach the renderer on INDEPENDENT transports: prompt_result
  // rides the pane's frame subscription (webContents.send), while the response's
  // agentInvoked flag is the ipcRenderer.invoke reply. Nothing orders one
  // against the other, so the frame can land first — and for an extension
  // command the response flag is a client-side DEFAULT of true, not a report.
  it('keeps a prompt_result correction when the defaulted response lands after it', () => {
    const dispatched = ompRpcTurnReducer(createInitialOmpRpcTurnState(), {
      type: 'command-dispatched',
      commandRunId: 'ext-run'
    })
    const corrected = [
      frame({ kind: 'command-output', text: 'extension says hello' }),
      frame({ kind: 'prompt-result', id: 'ext-run', agentInvoked: false })
    ].reduce(ompRpcTurnReducer, dispatched)

    // The invoke reply resolves only now, carrying the defaulted flag.
    const late = ompRpcTurnReducer(corrected, {
      type: 'command-agent-invoked',
      commandRunId: 'ext-run'
    })

    expect(late.commandInvokedAgent).toBe(false)
    expect(selectOmpRpcOverlayMessages(late, [])).toHaveLength(1)
  })

  it('still lets the response speak for a run whose prompt_result never came', () => {
    // A consumed builtin (/retry) gets NO prompt_result at all, so the response
    // flag has to remain the suppression signal there.
    const state = [
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      frame({ kind: 'command-output', text: 'retrying' }),
      { type: 'command-agent-invoked', commandRunId: 'retry-run' } as const
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandInvokedAgent).toBe(true)
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })

  it('re-arms the response signal for the next run that claims the slot', () => {
    // Authority is per-run: /usage's prompt_result must not deafen the reducer
    // to /retry's own agent-invoked report afterwards.
    const state = [
      { type: 'command-dispatched', commandRunId: 'usage-run' } as const,
      frame({ kind: 'prompt-result', id: 'usage-run', agentInvoked: false }),
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      frame({ kind: 'command-output', text: 'retrying' }),
      { type: 'command-agent-invoked', commandRunId: 'retry-run' } as const
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandInvokedAgent).toBe(true)
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })
})

describe('durable completed command output', () => {
  // A slash command's answer is never a transcript turn, so the capture slot is
  // its only home. Its lifetime is therefore the COMMAND boundary, not the turn
  // boundary — wiping it on the next agent_start loses the answer for good.
  it('survives the next turn, whose agent_start resets the overlay', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'help-run' } as const,
      frame({ kind: 'command-output', text: 'Available commands:\n/help' }),
      frame({ kind: 'prompt-result', id: 'help-run', agentInvoked: false }),
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } } as OmpRpcClientEvent)
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandOutputText).toBe('Available commands:\n/help')
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([
      {
        id: OMP_RPC_COMMAND_OUTPUT_ID,
        role: 'system',
        blocks: [{ type: 'text', text: 'Available commands:\n/help' }],
        timestamp: null,
        source: 'rpc'
      }
    ])
  })

  it('keeps its prompt_result correlation alive across that turn boundary', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'ext-run' } as const,
      frame({ kind: 'command-output', text: 'extension says hello' }),
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } } as OmpRpcClientEvent),
      { type: 'command-agent-invoked', commandRunId: 'ext-run' } as const,
      frame({ kind: 'prompt-result', id: 'ext-run', agentInvoked: false })
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandRunId).toBe('ext-run')
    expect(state.commandInvokedAgent).toBe(false)
  })

  it('keeps an agent-invoked command suppressed across the turn it started', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'retry-run' } as const,
      frame({ kind: 'command-output', text: 'retrying' }),
      { type: 'command-agent-invoked', commandRunId: 'retry-run' } as const,
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } } as OmpRpcClientEvent)
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })

  it('is still retired by the next command that claims the slot', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'help-run' } as const,
      frame({ kind: 'command-output', text: 'Available commands:' }),
      frame({ kind: 'agent-start', frame: { type: 'agent_start' } } as OmpRpcClientEvent),
      { type: 'command-dispatched', commandRunId: 'usage-run' } as const
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandOutputText).toBe('')
    expect(selectOmpRpcOverlayMessages(state, [])).toEqual([])
  })

  it('is dropped on an explicit reset — a different session owns the pane then', () => {
    const state = [
      { type: 'command-dispatched', commandRunId: 'help-run' } as const,
      frame({ kind: 'command-output', text: 'Available commands:' }),
      { type: 'reset' } as const
    ].reduce(ompRpcTurnReducer, createInitialOmpRpcTurnState())

    expect(state.commandOutputText).toBe('')
    expect(state.commandRunId).toBeNull()
  })
})
