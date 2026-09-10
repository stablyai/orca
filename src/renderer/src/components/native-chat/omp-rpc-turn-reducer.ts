// Pure reducer turning OMP RPC turn-lifecycle events into an in-progress-turn
// overlay for NativeChat. Verified live against omp 18.0.6: the assistant
// `message` object RPC frames carry has NO id corresponding to any transcript
// entry id (transcript entries use their own short hex ids; RPC frames carry
// none at the message level, only `toolCall.id` inside content). Because of
// this, RPC-sourced content is NEVER id-merged into the transcript list (D4) —
// it renders as a separate overlay, generalizing the existing hook-preview
// "leads" suppression (native-chat-streaming.ts) so the overlay disappears the
// instant the transcript already covers it. Double-rendering a turn is not an
// acceptable outcome.
//
// Also verified live: `message_start`/`message_update`/`message_end` frames
// are not assistant-only at the frame-type level — the outgoing user turn is
// also echoed through the same three frame types, with `message.role ===
// 'user'` and no `assistantMessageEvent`. This reducer never needs to filter
// for it: `message_start`/`message_end` are unused (not reducer boundaries —
// `agent_start`/`agent_end` bracket the whole prompt, including any tool-call
// round trips, and are the only reset points), and `message_update`'s
// `assistantMessageEvent` stream is assistant-only by construction.

import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import type { OmpRpcClientEvent } from '../../../../shared/omp-rpc-protocol'
import { dismissExtensionUiRequest, reduceExtensionUiRequest } from './omp-rpc-extension-ui-queue'
import {
  capOverlayBlocks,
  capOverlayText,
  OVERLAY_TEXT_MAX_CHARS
} from './omp-rpc-overlay-retention'
import {
  applyOmpRpcPublishedSessionIdentity,
  buildOmpRpcHydratedHistory,
  expireHydratedHistoryCoverage,
  growsSessionPastSnapshot,
  type OmpRpcHydratedHistory
} from './omp-rpc-hydrated-history-coverage'
import {
  applyOmpRpcThinkingLevelEvent,
  mergeOmpRpcSessionConfig,
  type OmpRpcSessionConfig
} from './omp-rpc-session-config-projection'
import { appendOmpRpcAdvisorCard, retireOmpRpcAdvisorCards } from './omp-rpc-advisor-card'
import {
  isOmpRpcSubagentRunningDetached,
  reduceOmpRpcSubagentEvent,
  reduceOmpRpcSubagentLifecycle,
  reduceOmpRpcSubagentProgress
} from './omp-rpc-subagent-roster'
import {
  appendOmpRpcToolCallBlock,
  upsertOmpRpcToolResultBlock
} from './omp-rpc-tool-block-projection'
import { createInitialOmpRpcTurnState, type OmpRpcTurnState } from './omp-rpc-turn-state'

export type { OmpRpcHydratedHistory, OmpRpcSessionConfig }

export type { OmpRpcSessionInfo, OmpRpcTurnState, OmpRpcTurnStatus } from './omp-rpc-turn-state'
export { createInitialOmpRpcTurnState } from './omp-rpc-turn-state'

export type OmpRpcTurnAction =
  | { type: 'frame'; event: OmpRpcClientEvent }
  | { type: 'extension-ui-answered'; requestId: string }
  /** A slash command was just dispatched over the owning session: retire the
   *  previous command's captured output before its frames start arriving, and
   *  take ownership of the capture slot under `commandRunId`. */
  | { type: 'command-dispatched'; commandRunId: string }
  /** The dispatched command's correlated `prompt` response reported that it
   *  started a real agent turn. Upstream sends no `prompt_result` frame for a
   *  consumed builtin (rpc-mode.ts returns `{ agentInvoked }` instead), so this
   *  is the only suppression signal such a command ever produces. Ignored when
   *  `commandRunId` no longer owns the slot: a late report from a superseded
   *  run would otherwise blank the current command's output. */
  | { type: 'command-agent-invoked'; commandRunId: string }
  /** A drained, decoded history snapshot for the owning session. */
  /** `sessionId` is the identity the pane drained under, so a later published
   *  identity can be told apart from a switch (`applyOmpRpcPublishedSessionIdentity`). */
  | {
      type: 'history-hydrated'
      messages: NativeChatMessage[]
      totalMessages: number
      sessionId?: string | null
    }
  /** Advisor cards the transcript now carries, reported by the render-time
   *  coverage check the reducer cannot make itself
   *  (`selectOmpRpcCoveredAdvisorTurnIds`). Retires them for good. */
  | { type: 'advisor-cards-covered'; turnIds: readonly string[] }
  | { type: 'session-identity-bound'; sessionId: string | null }
  | { type: 'reset' }

function appendTextBlock(blocks: NativeChatBlock[], delta: string): NativeChatBlock[] {
  const last = blocks.at(-1)
  if (last?.type === 'text') {
    return capOverlayBlocks([
      ...blocks.slice(0, -1),
      { type: 'text', text: capOverlayText(last.text + delta, OVERLAY_TEXT_MAX_CHARS) }
    ])
  }
  return capOverlayBlocks([...blocks, { type: 'text', text: delta }])
}

/** State a turn boundary must not reset. The session's own facts (title,
 *  model, command catalog) describe the session, not the turn. The slash-command
 *  capture slot rides along for a different reason: a command's answer is never
 *  a transcript turn, so this slot is its only home and its lifetime is the
 *  COMMAND boundary — the next `command-dispatched`, or a reset.
 *
 *  Detached subagents ride along for a third reason: their lifetime is their
 *  OWN, not the spawning turn's. Dropping a still-running one would strand it —
 *  its later progress frames name an id the roster no longer knows, and the
 *  roster's fail-closed admission rule drops them, so a background job that is
 *  still working would disappear from the pane for good. Terminal and attached
 *  entries still go, since neither can produce another frame worth showing. */
function carriedAcrossTurn(state: OmpRpcTurnState): Partial<OmpRpcTurnState> {
  return {
    subagents: state.subagents.filter(isOmpRpcSubagentRunningDetached),
    sessionInfo: state.sessionInfo,
    config: state.config,
    availableCommands: state.availableCommands,
    hydratedHistory: state.hydratedHistory,
    observedSessionGrowth: state.observedSessionGrowth,
    advisorCards: state.advisorCards,
    retiredAdvisorTurnIds: state.retiredAdvisorTurnIds,
    commandRunId: state.commandRunId,
    commandOutputText: state.commandOutputText,
    commandInvokedAgent: state.commandInvokedAgent,
    commandResultReported: state.commandResultReported
  }
}

function reduceFrame(state: OmpRpcTurnState, event: OmpRpcClientEvent): OmpRpcTurnState {
  switch (event.kind) {
    case 'agent-start':
      // Why: a fresh prompt/steer/follow_up turn starts a new overlay; without
      // this reset, the previous turn's content would bleed into the next.
      // sessionInfo/config/availableCommands/hydratedHistory are deliberately
      // carried across: they describe the SESSION (title, model, thinking
      // level, command catalog, drained history), not the turn, so a `/model`
      // change must not evaporate the moment the next prompt starts. Advisor
      // cards are carried for a different reason — the boundary is not proof
      // the transcript surfaced them (see `advisorCards`).
      return { ...createInitialOmpRpcTurnState(), ...carriedAcrossTurn(state), status: 'working' }
    case 'agent-end':
      return { ...state, status: event.frame.isTerminal === false ? 'working' : 'idle' }
    case 'message-update': {
      const assistantMessageEvent = event.frame.assistantMessageEvent
      // Why: absent means this is OMP's echo of the user's own turn (no
      // assistant content) — valid and non-fatal, nothing to render, but the
      // stream is live: register 'working' for a turn that starts without an
      // explicit agent_start.
      if (!assistantMessageEvent) {
        return state.status === 'working' ? state : { ...state, status: 'working' }
      }
      // Why: the union's D3 catch-all member (`{type:string} & Record<...>`)
      // widens `.delta` back to `unknown` for TS even after the `type` check,
      // since a literal-typed member and the wide-string fallback both match —
      // the client's frame validator already proved `delta` is a string.
      if (
        assistantMessageEvent.type === 'text_delta' &&
        typeof assistantMessageEvent.delta === 'string'
      ) {
        const delta = assistantMessageEvent.delta
        return {
          ...state,
          status: 'working',
          assistantText: capOverlayText(state.assistantText + delta, OVERLAY_TEXT_MAX_CHARS),
          blocks: appendTextBlock(state.blocks, delta)
        }
      }
      if (
        assistantMessageEvent.type === 'thinking_delta' &&
        typeof assistantMessageEvent.delta === 'string'
      ) {
        return {
          ...state,
          status: 'working',
          reasoningText: capOverlayText(
            state.reasoningText + assistantMessageEvent.delta,
            OVERLAY_TEXT_MAX_CHARS
          )
        }
      }
      return state.status === 'working' ? state : { ...state, status: 'working' }
    }
    case 'tool-execution-start':
      return {
        ...state,
        status: 'working',
        blocks: appendOmpRpcToolCallBlock(state.blocks, event.frame)
      }
    // Why: a streaming tool reports the output it has so far on the SAME row
    // its end frame finalizes. A frame with nothing to show yet must not open
    // an empty result row under the call.
    case 'tool-execution-update':
      return event.partialOutput === ''
        ? state
        : {
            ...state,
            status: 'working',
            blocks: upsertOmpRpcToolResultBlock(state.blocks, {
              toolCallId: event.frame.toolCallId,
              output: event.partialOutput,
              isError: false
            })
          }
    case 'tool-execution-end':
      return {
        ...state,
        blocks: upsertOmpRpcToolResultBlock(state.blocks, {
          toolCallId: event.frame.toolCallId,
          output: event.output,
          isError: event.isError
        })
      }
    case 'subagent-lifecycle':
      return {
        ...state,
        subagents: reduceOmpRpcSubagentLifecycle(state.subagents, event.frame.payload)
      }
    case 'subagent-progress':
      return {
        ...state,
        subagents: reduceOmpRpcSubagentProgress(state.subagents, event.frame.payload)
      }
    // The child's own event stream: the only source for what a subagent is
    // running and saying right now, which `subagent_progress` never carries.
    case 'subagent-event': {
      const subagents = reduceOmpRpcSubagentEvent(state.subagents, event.frame.payload)
      return subagents === state.subagents ? state : { ...state, subagents }
    }
    case 'extension-ui-request':
      return reduceExtensionUiRequest(state, event.frame)
    case 'recap-update':
      return { ...state, latestRecap: event.recap }
    case 'command-output':
      // Why: a command routed over the OWNING session returns its answer only
      // as these frames — there is no TUI left to print it into (D1).
      return {
        ...state,
        commandOutputText: capOverlayText(
          state.commandOutputText + event.text,
          OVERLAY_TEXT_MAX_CHARS
        )
      }
    case 'prompt-result':
      // `id` is the request id the dispatching run chose for its own prompt
      // (== commandRunId), so a report belongs to exactly one run: a superseded
      // command's late frame, or a plain chat prompt's (those use the client's
      // own id sequence), can never reach this slot. Correlating is the only
      // sound option — the send queue cannot instead hold the slot until this
      // frame lands, because upstream emits none at all once an agent turn
      // started (reportLocalOnlyPromptResult returns early), so the wait would
      // never end. An id-less frame matches no claimed slot and is ignored.
      if (event.id !== state.commandRunId) {
        return state
      }
      // False is a correction, not a no-op. An extension command's `prompt`
      // response carries no agentInvoked field at all (upstream falls through
      // to session.prompt for it), so the client defaults it to true and
      // suppresses the capture; this frame is the authoritative word that no
      // agent ran, and without it the command's output would never render.
      // The verdict LATCHES rather than merely applying, because "authoritative"
      // cannot mean "last writer wins" here: the defaulted response arrives on
      // the invoke reply, unordered against this frame, so a response resolving
      // afterwards would otherwise re-suppress output this frame just released.
      if (state.commandResultReported && state.commandInvokedAgent === event.agentInvoked) {
        return state
      }
      return { ...state, commandResultReported: true, commandInvokedAgent: event.agentInvoked }
    case 'session-info': {
      const applied = applyOmpRpcPublishedSessionIdentity(state, event)
      // Why (XLR-033): a proven switch means every OTHER projection here still
      // describes the session just switched away from — assistant/reasoning
      // text, tool blocks, advisor cards and their retirement ledger, detached
      // subagents, the recap, the config and the command catalog. Dropping only
      // the hydrated history left A's content rendering over B, and left A's
      // configuration and commands usable until B happened to republish. The
      // slash-command capture slot is the one thing carried across: the command
      // that CAUSED the switch still owns it, and its output and pending
      // `prompt_result` are not projections of A.
      return applied.switched
        ? {
            ...createInitialOmpRpcTurnState(),
            sessionInfo: applied.sessionInfo,
            availableCommands: state.availableCommands,
            commandRunId: state.commandRunId,
            commandOutputText: state.commandOutputText,
            commandInvokedAgent: state.commandInvokedAgent,
            commandResultReported: state.commandResultReported
          }
        : { ...state, sessionInfo: applied.sessionInfo }
    }
    case 'config-update':
      return { ...state, config: mergeOmpRpcSessionConfig(state.config, event) }
    // Documented session events Orca forwards but does not render. Only the
    // thinking level names state the pane already shows, so only it projects;
    // an absent level means "unknown", so the last known value is kept.
    case 'session-event': {
      const config = applyOmpRpcThinkingLevelEvent(state.config, event.frame)
      return config === null ? state : { ...state, config }
    }
    // Why: the transport is dead — no further frames will arrive for this
    // turn, so it can no longer be "working" (the session hook is
    // responsible for the D1 fallback-to-PTY reaction; see
    // use-omp-rpc-chat-session.ts).
    case 'protocol-fault':
    case 'exit':
      return state.status === 'idle' ? state : { ...state, status: 'idle' }
    // Session-scoped like sessionInfo/config: republished whenever OMP's
    // command metadata changes, and never invalidated by a turn boundary.
    case 'commands':
      return { ...state, availableCommands: event.commands }
    // An advisor card is the one message frame carrying content of its own:
    // `message_update` never streams it, so without reading the frame's message
    // the note is invisible until the transcript tailer catches up.
    case 'message-start':
    case 'message-end': {
      const advisorCards = appendOmpRpcAdvisorCard(state, event.frame.message)
      return advisorCards === state.advisorCards ? state : { ...state, advisorCards }
    }
    // Why: no-op — these carry nothing this milestone's overlay renders.
    case 'turn-start':
    case 'turn-end':
    case 'ready':
    case 'unknown-frame':
      return state
  }
}

export function ompRpcTurnReducer(
  state: OmpRpcTurnState,
  action: OmpRpcTurnAction
): OmpRpcTurnState {
  if (action.type === 'reset') {
    return createInitialOmpRpcTurnState()
  }
  if (action.type === 'extension-ui-answered') {
    return dismissExtensionUiRequest(state, action.requestId)
  }
  if (action.type === 'session-identity-bound') {
    return { ...state, boundSessionId: action.sessionId }
  }
  if (action.type === 'command-dispatched') {
    return {
      ...state,
      commandRunId: action.commandRunId,
      commandOutputText: '',
      commandInvokedAgent: false,
      commandResultReported: false
    }
  }
  if (action.type === 'history-hydrated') {
    // Why (XLR-032): the acquisition generation cannot fence this — a command
    // switching the SAME acquired child never changes it — so a drain started
    // under A can still land after B was published, and the merge would fold
    // A's records into B's transcript. The snapshot's own drain identity is the
    // only proof of which session it describes; an unnamed drain still proves
    // nothing either way and is kept, as before.
    if (
      action.sessionId != null &&
      state.sessionInfo?.sessionId != null &&
      state.sessionInfo.sessionId !== action.sessionId
    ) {
      return state
    }
    return {
      ...state,
      hydratedHistory: buildOmpRpcHydratedHistory(action, state.observedSessionGrowth)
    }
  }
  if (action.type === 'advisor-cards-covered') {
    const retired = retireOmpRpcAdvisorCards(state, action.turnIds)
    return retired ? { ...state, ...retired } : state
  }
  if (action.type === 'command-agent-invoked') {
    // Yields to a latched `prompt_result`: that frame is the run's own report,
    // while this flag may be the client's default for a command upstream never
    // reported on. Also ignored once a later run owns the slot.
    return state.commandRunId === action.commandRunId && !state.commandResultReported
      ? { ...state, commandInvokedAgent: true }
      : state
  }
  const next = reduceFrame(state, action.event)
  return growsSessionPastSnapshot(action.event)
    ? {
        ...next,
        observedSessionGrowth: true,
        hydratedHistory: expireHydratedHistoryCoverage(next.hydratedHistory)
      }
    : next
}

/** True while the RPC frame stream should drive the pane's live chat status —
 *  a lifecycle fact (D5), not a content fact: derived from `status` alone so
 *  it clears the instant a turn ends, even though `assistantText`/`blocks`
 *  deliberately survive past `agent-end` for the leads-vs-transcript compare
 *  in `selectOmpRpcOverlayMessages`. */
export function isOmpRpcTurnActive(state: OmpRpcTurnState): boolean {
  return state.status === 'working'
}
