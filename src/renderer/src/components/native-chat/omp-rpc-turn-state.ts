// The pane's OMP RPC turn state and its empty value. Split from the reducer
// that transitions it (omp-rpc-turn-reducer.ts, which re-exports both) so
// neither file exceeds its max-lines budget: the shape and its per-field
// lifetime rules are what belong together here.

import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type {
  OmpRpcExtensionUiRequestFrame,
  OmpRpcRecap,
  OmpRpcSlashCommand
} from '../../../../shared/omp-rpc-protocol'
import type { OmpRpcAdvisorCard } from './omp-rpc-advisor-card'
import type { OmpRpcHydratedHistory } from './omp-rpc-hydrated-history-coverage'
import type { OmpRpcSessionConfig } from './omp-rpc-session-config-projection'
import type { OmpRpcSubagentRosterEntry } from './omp-rpc-subagent-roster'

export type OmpRpcTurnStatus = 'idle' | 'working'

/** The session's own identity, republished by every builtin command that
 *  renames it (`session_info_update`). Session-scoped, not turn-scoped. */
export type OmpRpcSessionInfo = { title: string | null; sessionId: string | null }

export type OmpRpcTurnState = {
  /** The session identity resolved during acquisition, before OMP publishes its first frame. */
  boundSessionId?: string | null
  status: OmpRpcTurnStatus
  assistantText: string
  reasoningText: string
  blocks: NativeChatBlock[]
  pendingExtensionUiRequest: OmpRpcExtensionUiRequestFrame | null
  queuedExtensionUiRequests: OmpRpcExtensionUiRequestFrame[]
  latestRecap: OmpRpcRecap | null
  /** Identifies the slash command run that owns the capture slot below, and is
   *  also the wire request id that run's `prompt` was sent under — so a
   *  `prompt_result` frame can be attributed to it and any late report from a
   *  superseded run refused. OMP's `command_output` frames carry no id at all,
   *  which is why the send path serialises commands. */
  commandRunId: string | null
  /** `command_output` captured for the slash command currently in flight over
   *  the owning session. Cleared when the next command or turn starts. */
  commandOutputText: string
  /** True once the in-flight command reported it started a real agent turn, so
   *  its captured output must NOT also render (message_update carries it). */
  commandInvokedAgent: boolean
  /** True once the owning run's `prompt_result` has spoken. It latches the
   *  verdict: that frame rides the pane's frame subscription while the
   *  response's `agentInvoked` rides the invoke reply, and nothing orders the
   *  two transports — so the response can land AFTER the frame, carrying (for
   *  an extension command) a client-side default rather than a report. */
  commandResultReported: boolean
  /** Session-scoped side-channel state; survives a turn reset by design. */
  sessionInfo: OmpRpcSessionInfo | null
  config: OmpRpcSessionConfig | null
  /** OMP's published RPC command catalog (`available_commands_update`) — the
   *  only proof of which slash commands this session can actually execute,
   *  since it omits every builtin with no text-mode handler. Null until the
   *  session publishes one. */
  availableCommands: OmpRpcSlashCommand[] | null
  /** Reconnect history hydration (session-scoped): what the owning RPC session
   *  says its history is, so a pane whose transcript file has not caught up
   *  still renders the turns OMP is holding. Null until a drain lands. */
  hydratedHistory: OmpRpcHydratedHistory | null
  /** Whether a growth frame has been seen on this session yet. A latch, not a
   *  reaction: the frame subscription and the history invocation are unordered,
   *  so growth can arrive while `hydratedHistory` is still null and leave
   *  nothing to expire. Session-scoped, cleared only by a reset. */
  observedSessionGrowth: boolean
  /** Subagents this turn spawned, in the order OMP indexed them. Turn-scoped
   *  with one exception: a subagent belongs to the run that spawned it, so
   *  `agent_start` clears it rather than carrying it forward like the
   *  session-scoped fields above — but a DETACHED spawn keeps running past its
   *  parent turn, so a still-running one survives the boundary
   *  (`carriedAcrossTurn`). Empty until `set_subagent_subscription` turns
   *  forwarding on. */
  subagents: OmpRpcSubagentRosterEntry[]
  /** Advisor note batches OMP published, in arrival order. Carried across the
   *  turn boundary, unlike `blocks`: OMP emits the card's `message_end` BEFORE
   *  it persists the transcript entry, so a turn boundary is no evidence the
   *  transcript surfaced the card, and clearing here would drop the only
   *  rendered copy. Transcript coverage owns retirement — the render-time
   *  check reports it back as `advisor-cards-covered`
   *  (omp-rpc-turn-overlay.ts) — so the retention budget, not the boundary,
   *  is what bounds this list. */
  advisorCards: OmpRpcAdvisorCard[]
  /** Identities of cards the transcript has already surfaced. Retirement has
   *  to be recorded, not just acted on: the transcript is a bounded window, so
   *  the row that proved coverage scrolls out of it, and a card the overlay
   *  merely hid would then reappear at the tail as fresh advice. The ledger
   *  also refuses the card's other boundary frame re-adding it. */
  retiredAdvisorTurnIds: string[]
}

export function createInitialOmpRpcTurnState(): OmpRpcTurnState {
  return {
    status: 'idle',
    assistantText: '',
    reasoningText: '',
    blocks: [],
    pendingExtensionUiRequest: null,
    queuedExtensionUiRequests: [],
    latestRecap: null,
    commandRunId: null,
    commandOutputText: '',
    commandInvokedAgent: false,
    commandResultReported: false,
    sessionInfo: null,
    config: null,
    availableCommands: null,
    hydratedHistory: null,
    observedSessionGrowth: false,
    subagents: [],
    advisorCards: [],
    retiredAdvisorTurnIds: []
  }
}
