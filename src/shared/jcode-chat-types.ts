// Why: shared between the main-process jcode chat session spawner and the
// renderer ChatPane so both agree on the IPC payload shape. jcode emits
// newline-delimited JSON ("--ndjson"); we forward each parsed object verbatim
// as `event` plus a synthetic `sessionKey` so the renderer can route events to
// the correct chat pane.

/** One parsed jcode --ndjson line. Loosely typed on purpose: jcode owns the
 *  schema and may add event kinds; the renderer switches on `type` and ignores
 *  unknown kinds. The documented kinds (see HANDOFF / M1 brief) are:
 *  start | status_detail | connection_phase | connection_type | tool_start |
 *  tool_input | tool_exec | tool_done | text_delta | message_end | tokens |
 *  done | error. */
export type JcodeNdjsonEvent = {
  type: string
  [key: string]: unknown
}

/** Envelope the main process sends to the renderer over 'jcode-chat:event'. */
export type JcodeChatEventMessage = {
  sessionKey: string
  event: JcodeNdjsonEvent
}

/** Payload the renderer sends over 'jcode-chat:stop' to cancel an in-flight turn. */
export type JcodeChatStopPayload = {
  /** Stable per-pane key whose in-flight jcode child should be killed. */
  sessionKey: string
}

/** Payload the renderer sends over 'jcode-chat:send' to start one turn. */
export type JcodeChatSendPayload = {
  /** Stable per-pane key (tab/worktree id) used to route events back. */
  sessionKey: string
  prompt: string
  /** jcode provider id, e.g. 'openai'. */
  provider?: string
  /** jcode model id, e.g. 'gpt-5.5'. */
  model?: string
  /** Working directory passed to jcode via -C. */
  cwd?: string
  /** jcode session id (from a prior 'start'/'done' event) to continue a turn. */
  resumeSessionId?: string
  /** brain-local (M3): only bash runs over SSH on this host. Wired now, used later. */
  remoteExecHost?: string
}

export const JCODE_CHAT_SEND_CHANNEL = 'jcode-chat:send'
export const JCODE_CHAT_STOP_CHANNEL = 'jcode-chat:stop'
export const JCODE_CHAT_EVENT_CHANNEL = 'jcode-chat:event'
