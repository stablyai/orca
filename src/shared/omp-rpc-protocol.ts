// OMP JSONL RPC v2 wire contract (subset Orca consumes), verified against
// omp 18.0.6 and the published rpc-types.d.ts. Shared so desktop main, the
// renderer, and tests validate identically. Field names are verbatim wire names.

import type {
  OmpRpcSubagentEventFrame,
  OmpRpcSubagentLifecycleFrame,
  OmpRpcSubagentProgressFrame,
  OmpRpcSubagentSubscriptionLevel
} from './omp-rpc-subagent-protocol'

/** First frame OMP emits on stdout; protocolVersion is literally 1 pre-negotiation. */
export type OmpRpcReadyFrame = {
  type: 'ready'
  protocolVersion: 1
  supportedProtocolVersions: number[]
  maxFrameBytes: number
  maxReassembledFrameBytes: number
}

/** One entry of the live slash-command catalog. */
export type OmpRpcSlashCommand = {
  name: string
  aliases?: string[]
  description?: string
  input?: { hint?: string }
  subcommands?: { name: string; description?: string; usage?: string }[]
  source?: string
}

/** Server-pushed catalog; also the get_available_commands response payload shape. */
export type OmpRpcAvailableCommandsUpdateFrame = {
  type: 'available_commands_update'
  commands: OmpRpcSlashCommand[]
}

/** Complete output of a slash command (e.g. /usage). Untyped upstream; text is markdown-ish. */
export type OmpRpcCommandOutputFrame = {
  type: 'command_output'
  text: string
}

/** Terminal marker for a prompt: agentInvoked=false means a local command completed
 *  without invoking the model — the UI must not fabricate an assistant turn. */
export type OmpRpcPromptResultFrame = {
  type: 'prompt_result'
  id?: string
  agentInvoked: boolean
}

/** v2 transport chunk for one oversized logical frame (strictly in-order). */
export type OmpRpcChunkFrame = {
  type: 'rpc_chunk'
  chunkId: string
  index: number
  count: number
  byteLength: number
  data: string
}

/** Correlated command response envelope (success and error branches). */
export type OmpRpcResponseFrame = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

export type OmpRpcRecap = {
  text: string
  trigger: 'idle'
  timestamp: number
}

export type OmpRpcRecapUpdateFrame = {
  type: 'recap_update'
  recap: OmpRpcRecap | null
}

/** Builtin slash-command side channel: OMP republishes the session's own
 *  identity after a command renames it (`/rename`, `/model`, `/move` all fire
 *  it via `notifyTitleChanged`). Both fields are `| undefined` upstream
 *  (`session.sessionName`, `session.sessionId`) and JSON drops an undefined
 *  property, so a bare frame is a valid shape, not a fault. */
export type OmpRpcSessionInfoUpdateFrame = {
  type: 'session_info_update'
  title?: string | null
  sessionId?: string | null
}

/** The model half of a `config_update`. Upstream this is the catalog's full
 *  `Model` interface (100+ fields); only the three this integration reads are
 *  typed, the rest passes through — a floor, not a ceiling (D3). */
export type OmpRpcConfigModel = {
  id?: string
  name?: string
  provider?: string
} & Record<string, unknown>

/** Builtin slash-command side channel: the session's model/thinking selection
 *  after `/model` or `/move` (`notifyConfigChanged`). `thinkingLevel` is
 *  OMP's `ThinkingLevel` union (inherit/off/minimal/low/medium/high/xhigh/max)
 *  — carried as a string rather than re-declared, since OMP owns that list. */
export type OmpRpcConfigUpdateFrame = {
  type: 'config_update'
  model?: OmpRpcConfigModel | null
  thinkingLevel?: string | null
}

export type OmpRpcSessionState = {
  sessionFile: string | null
  sessionId: string | null
  isStreaming: boolean
  isCompacting: boolean
  queuedMessageCount: number
}

/** One entry of a history page. Upstream this is OMP's full `AgentMessage`
 *  union; it passes through untyped because the decoder that renders it is
 *  transcript-shaped, not wire-shaped (D3 floor, as with `config_update.model`). */
export type OmpRpcHistoryMessage = Record<string, unknown>

/** `get_messages_page` success payload. `nextCursor` is opaque and bound
 *  upstream to (sessionId, leafId, messageCount) — never reinterpret it. */
export type OmpRpcMessagesPage = {
  messages: OmpRpcHistoryMessage[]
  nextCursor?: string
  totalMessages: number
}

/** The two machine-readable `code`s `get_messages_page` can fail with. Matching
 *  these instead of the error text is the documented contract (rpc.md:192). */
export type OmpRpcMessagesPageErrorCode = 'session_busy' | 'stale_cursor'

/** A drained history read. `session-busy` is a legitimate wire outcome, not a
 *  failure: upstream refuses to start a paging walk while the session is
 *  streaming or compacting, so the caller retries once the session settles. */
export type OmpRpcHistoryResult =
  | { kind: 'complete'; messages: OmpRpcHistoryMessage[]; totalMessages: number }
  | { kind: 'session-busy' }

export type OmpRpcExit = {
  code: number | null
  signal: string | null
}

/** One image attachment on a prompt-like command. Wire shape per rpc.md's
 *  `ImageContent`; only what this integration sends is typed. */
export type OmpRpcImageContent = { type: 'image'; mimeType: string; data: string }

/** How a prompt-like command interacts with an in-progress turn. OMP requires
 *  this on `prompt` while the session is actively streaming (omitted -> the
 *  command fails); `steer`/`follow_up` are its dedicated-verb equivalents. */
export type OmpRpcStreamingBehavior = 'steer' | 'followUp'

/** Raw provider-normalized assistant stream event carried by `message_update`
 *  (field name verified via sdk.md: `event.assistantMessageEvent`). Text and
 *  thinking triplets are typed at byte level; `toolcall_*` member fields beyond
 *  `type` are UNKNOWN in the docs, so they stay optional-tolerant passthrough —
 *  a floor, not a ceiling, per the plan's D3. */
export type OmpRpcAssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_end' }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | ({ type: 'toolcall_start' } & Record<string, unknown>)
  | ({ type: 'toolcall_delta' } & Record<string, unknown>)
  | ({ type: 'toolcall_end' } & Record<string, unknown>)
  | { type: 'image_end' }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' }
  | { type: 'error'; reason: 'aborted' | 'error' }
  | ({ type: string } & Record<string, unknown>)

/** Turn/agent lifecycle frames. `isTerminal:false` on agent_end means
 *  maintenance/async work will resume the session before it truly settles;
 *  treat only `isTerminal !== false` (absent counts as terminal) as done. */
export type OmpRpcAgentStartFrame = { type: 'agent_start' } & Record<string, unknown>
export type OmpRpcAgentEndFrame = {
  type: 'agent_end'
  messages?: unknown[]
  isTerminal?: boolean
} & Record<string, unknown>
export type OmpRpcTurnStartFrame = { type: 'turn_start' } & Record<string, unknown>
export type OmpRpcTurnEndFrame = { type: 'turn_end' } & Record<string, unknown>

/** Message lifecycle frames wrapping the assistant-message-in-progress. */
export type OmpRpcMessageStartFrame = {
  type: 'message_start'
  message?: unknown
} & Record<string, unknown>
export type OmpRpcMessageUpdateFrame = {
  type: 'message_update'
  assistantMessageEvent?: OmpRpcAssistantMessageEvent
  message?: unknown
} & Record<string, unknown>
export type OmpRpcMessageEndFrame = {
  type: 'message_end'
  message?: unknown
} & Record<string, unknown>

/** Tool execution frames. rpc.md names the three types without spelling out
 *  their fields; the byte-level shape is canonical `AgentEvent`
 *  (packages/agent/src/types.ts) and is verified live against omp 18.0.11:
 *  the argument payload is `args` (NOT `input`) and the completed payload is
 *  `result` (NOT `content`), where `result` is a ToolResult envelope
 *  (`{content: ContentBlock[], details?}`), never a bare string. An earlier
 *  revision typed these from the extension hook's tool_call/tool_result
 *  payload, which is a different subsystem — every read of `input`/`content`
 *  was silently undefined. Fields beyond these still pass through (D3 floor). */
export type OmpRpcToolExecutionStartFrame = {
  type: 'tool_execution_start'
  toolCallId?: string
  toolName?: string
  args?: unknown
  /** The model's own one-line reason for the call, when the tool declares it. */
  intent?: string
} & Record<string, unknown>
export type OmpRpcToolExecutionUpdateFrame = {
  type: 'tool_execution_update'
  toolCallId?: string
  toolName?: string
  args?: unknown
  /** Same envelope as `result`, carrying the output produced so far. */
  partialResult?: unknown
} & Record<string, unknown>
export type OmpRpcToolExecutionEndFrame = {
  type: 'tool_execution_end'
  toolCallId?: string
  toolName?: string
  result?: unknown
  isError?: boolean
} & Record<string, unknown>

/** Extension UI sub-protocol: the only surface tool approval / questions /
 *  notifications arrive on (no dedicated approval frame exists). Method-
 *  specific fields are all optional so unhandled methods (notify/setStatus/
 *  setWidget/setTitle/...) still decode for log-and-ignore handling. */
export type OmpRpcExtensionUiRequestFrame = {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  message?: string
  timeout?: number
  options?: string[]
  optionDetails?: { description?: string }[]
} & Record<string, unknown>

/** Client->server reply to an extension_ui_request. Shape depends on the
 *  request's method (select/input/editor use `value`, confirm uses
 *  `confirmed`, cancel/timeout uses `cancelled`). Unknown-id replies are
 *  silently ignored server-side. */
export type OmpRpcExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true; timedOut?: boolean }

/** Forwarded subagent frames, gated by `set_subagent_subscription`. */
export type OmpRpcSubagentFrame =
  | OmpRpcSubagentLifecycleFrame
  | OmpRpcSubagentProgressFrame
  | OmpRpcSubagentEventFrame

/** Frames this integration understands today; everything else stays OmpRpcUnknownFrame. */
export type OmpRpcKnownServerFrame =
  | OmpRpcReadyFrame
  | OmpRpcAvailableCommandsUpdateFrame
  | OmpRpcCommandOutputFrame
  | OmpRpcPromptResultFrame
  | OmpRpcChunkFrame
  | OmpRpcResponseFrame
  | OmpRpcAgentStartFrame
  | OmpRpcAgentEndFrame
  | OmpRpcTurnStartFrame
  | OmpRpcTurnEndFrame
  | OmpRpcMessageStartFrame
  | OmpRpcMessageUpdateFrame
  | OmpRpcMessageEndFrame
  | OmpRpcToolExecutionStartFrame
  | OmpRpcToolExecutionUpdateFrame
  | OmpRpcToolExecutionEndFrame
  | OmpRpcExtensionUiRequestFrame
  | OmpRpcRecapUpdateFrame
  | OmpRpcSessionInfoUpdateFrame
  | OmpRpcConfigUpdateFrame
  | OmpRpcSubagentFrame

/** Lossless fallback: an unrecognized-but-parsed JSON frame. Never dropped silently. */
export type OmpRpcUnknownFrame = { type: string } & Record<string, unknown>

export type OmpRpcServerFrame = OmpRpcKnownServerFrame | OmpRpcUnknownFrame

/** Client->server commands consumed by this integration. */
export type OmpRpcCommand =
  | { id?: string; type: 'negotiate_protocol'; protocolVersion: number }
  | { id?: string; type: 'get_available_commands' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'get_messages_page'; cursor?: string; limit?: number }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | {
      id?: string
      type: 'prompt'
      message: string
      images?: OmpRpcImageContent[]
      streamingBehavior?: OmpRpcStreamingBehavior
    }
  | { id?: string; type: 'steer'; message: string; images?: OmpRpcImageContent[] }
  | { id?: string; type: 'follow_up'; message: string; images?: OmpRpcImageContent[] }
  | { id?: string; type: 'abort' }
  | {
      id?: string
      type: 'set_subagent_subscription'
      level: OmpRpcSubagentSubscriptionLevel
    }

/** Events the main-process client emits to consumers (IPC layer, tests). */
export type OmpRpcClientEvent =
  | { kind: 'ready'; ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }
  | { kind: 'commands'; commands: OmpRpcSlashCommand[] }
  | { kind: 'command-output'; text: string }
  | { kind: 'prompt-result'; id?: string; agentInvoked: boolean }
  | { kind: 'agent-start'; frame: OmpRpcAgentStartFrame }
  | { kind: 'agent-end'; frame: OmpRpcAgentEndFrame }
  | { kind: 'turn-start'; frame: OmpRpcTurnStartFrame }
  | { kind: 'turn-end'; frame: OmpRpcTurnEndFrame }
  | { kind: 'message-start'; frame: OmpRpcMessageStartFrame }
  | { kind: 'message-update'; frame: OmpRpcMessageUpdateFrame }
  | { kind: 'message-end'; frame: OmpRpcMessageEndFrame }
  | { kind: 'tool-execution-start'; frame: OmpRpcToolExecutionStartFrame }
  /** `partialOutput` is `frame.partialResult` already flattened to display
   *  text main-side, so the renderer never decodes OMP's ToolResult envelope. */
  | { kind: 'tool-execution-update'; frame: OmpRpcToolExecutionUpdateFrame; partialOutput: string }
  | {
      kind: 'tool-execution-end'
      frame: OmpRpcToolExecutionEndFrame
      output: string
      isError: boolean
    }
  | { kind: 'extension-ui-request'; frame: OmpRpcExtensionUiRequestFrame }
  | { kind: 'subagent-lifecycle'; frame: OmpRpcSubagentLifecycleFrame }
  | { kind: 'subagent-progress'; frame: OmpRpcSubagentProgressFrame }
  | { kind: 'subagent-event'; frame: OmpRpcSubagentEventFrame }
  | { kind: 'recap-update'; recap: OmpRpcRecap | null }
  | { kind: 'session-info'; title: string | null; sessionId: string | null }
  | { kind: 'config-update'; model: OmpRpcConfigModel | null; thinkingLevel: string | null }
  | { kind: 'unknown-frame'; frame: OmpRpcUnknownFrame }
  | { kind: 'session-event'; frame: OmpRpcUnknownFrame }
  | { kind: 'protocol-fault'; message: string }
  | { kind: 'exit'; code: number | null; signal: string | null }

export function isOmpRpcReadyFrame(frame: OmpRpcServerFrame): frame is OmpRpcReadyFrame {
  return frame.type === 'ready'
}

export function isOmpRpcChunkFrame(frame: OmpRpcServerFrame): frame is OmpRpcChunkFrame {
  return frame.type === 'rpc_chunk'
}

/** Launch options for a main-process OMP RPC child. Session-less is the safe
 *  default; owning a real session requires the explicit session-owning mode. */
export type OmpRpcBaseSpawnOptions = {
  executablePath: string
  cwd: string
  /** Arguments owned by the configured launch command, before the RPC mode. */
  commandArgs?: string[]
  extraArgs?: string[]
}

export type OmpRpcSpawnOptions = OmpRpcBaseSpawnOptions &
  (
    | { sessionMode: 'session-owning'; noSession?: never }
    | { sessionMode?: 'session-less'; noSession?: true }
  )

/** Contract between the IPC layer and the concrete client in src/main/omp-rpc/.
 *  The IPC layer codes against this type only. */
export type OmpRpcClientLike = {
  /** Resolves after the ready frame is validated and protocol v2 is negotiated. */
  whenReady(): Promise<{ ready: OmpRpcReadyFrame; negotiatedProtocolVersion: number }>
  /** Correlated get_available_commands; also emitted as a 'commands' event. */
  getCommands(): Promise<OmpRpcSlashCommand[]>
  /** Correlated prompt. For a local command the result carries agentInvoked=false
   *  and any command_output arrives as 'command-output' events before settlement.
   *  `streamingBehavior` is required by OMP while the session is streaming.
   *  `requestId` pins the wire `id`, which OMP echoes on the later
   *  `prompt_result` frame — the caller's only way to attribute that frame to
   *  the run that sent this prompt. Refused if it could alias another
   *  in-flight command. */
  prompt(
    message: string,
    options?: {
      images?: OmpRpcImageContent[]
      streamingBehavior?: OmpRpcStreamingBehavior
      requestId?: string
    }
  ): Promise<{ agentInvoked: boolean }>
  /** Interrupt path: a queued steering message that can affect the in-progress turn. */
  steer(message: string, images?: OmpRpcImageContent[]): Promise<{ agentInvoked: boolean }>
  /** Post-turn path: queued to run only after the current turn settles. */
  followUp(message: string, images?: OmpRpcImageContent[]): Promise<{ agentInvoked: boolean }>
  /** Fire-and-forget reply to an extension_ui_request. False when the transport
   *  cannot accept writes (disposed/exited) — the dialog then simply times out
   *  server-side, which is safe by design (rpc.md: server resolves a default). */
  respondExtensionUi(response: OmpRpcExtensionUiResponse): boolean
  on(listener: (event: OmpRpcClientEvent) => void): () => void
  dispose(): void
  /** Settles once the child has actually exited — the proof a teardown
   *  barrier waits on, since `dispose()` only starts the SIGTERM. */
  whenExited(): Promise<OmpRpcExit>
}

export type OmpSessionOwningRpcClient = OmpRpcClientLike & {
  getState(): Promise<OmpRpcSessionState>
  /** One raw `get_messages_page` request. Strict by design — it never falls back
   *  to the legacy monolithic `get_messages`, so a caller can never silently mix
   *  two snapshots. Prefer `fetchHistory` unless you are driving the walk. */
  getMessagesPage(options?: { cursor?: string; limit?: number }): Promise<OmpRpcMessagesPage>
  /** Drains the whole paged history for the session this client owns, proving
   *  the walk covered exactly `totalMessages` messages with no repeated cursor. */
  fetchHistory(options?: { limit?: number }): Promise<OmpRpcHistoryResult>
  /** Turns on subagent forwarding, which defaults to `off`. Resolves with the
   *  level the server actually selected — the client never assumes its own. */
  setSubagentSubscription(
    level: OmpRpcSubagentSubscriptionLevel
  ): Promise<OmpRpcSubagentSubscriptionLevel>
  switchSession(sessionPath: string): Promise<void>
  abort(): Promise<void>
}
