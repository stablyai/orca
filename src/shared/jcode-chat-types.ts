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
  /** Named custom OpenAI-compatible provider profile (from `jcode provider add`).
   *  When set, the main process spawns jcode with `--provider-profile <name>`
   *  (which IMPLIES openai-compatible) and OMITS `-p`. Takes precedence over
   *  `provider`. `-m model` is still honored to override the profile default. */
  providerProfile?: string
  /** jcode model id, e.g. 'gpt-5.5'. */
  model?: string
  /** Working directory passed to jcode via -C. */
  cwd?: string
  /** jcode session id (from a prior 'start'/'done' event) to continue a turn. */
  resumeSessionId?: string
  /** Worktree / folder-workspace key for this chat pane. The MAIN process uses
   *  it to resolve brain-local (M3) state authoritatively from its Store: if the
   *  folder workspace is `isRemoteExecOnly`, jcode is spawned LOCALLY with
   *  `--remote-exec <host>` (host from the workspace's SSH target). */
  worktreeId?: string
  /** brain-local (M3): explicit override for the remote-exec host. Normally the
   *  main process resolves the host from `worktreeId`; this is only honored when
   *  no worktree-derived host is available (e.g. ad-hoc callers). */
  remoteExecHost?: string
}

/** Authentication style jcode uses for a custom OpenAI-compatible provider. */
export type JcodeProviderAuth = 'bearer' | 'api-key' | 'none'

/** A user-added custom OpenAI-compatible provider profile. The API key is NOT
 *  stored here — it lives in jcode's private provider env file (written via
 *  `jcode provider add --api-key-stdin`). This record only mirrors the
 *  non-secret config so the composer + settings can list profiles. */
export type JcodeCustomProvider = {
  /** Profile name; passed to jcode as `--provider-profile <name>`. */
  name: string
  /** OpenAI-compatible base URL, e.g. https://llm.example.com/v1 */
  baseUrl: string
  /** Default model id for this profile. */
  model: string
  /** Auth style; defaults to 'bearer' when omitted. */
  auth?: JcodeProviderAuth
}

/** Renderer -> main args to add a custom provider. The API key (when present)
 *  is delivered over the child's STDIN, never as an argv flag. */
export type JcodeProviderAddArgs = {
  name: string
  baseUrl: string
  model: string
  auth?: JcodeProviderAuth
  /** Optional custom auth header name (jcode `--auth-header`). */
  authHeader?: string
  /** API key value; written to jcode's stdin via `--api-key-stdin`. When empty
   *  / omitted the provider is added with `--no-api-key`. */
  apiKey?: string
}

/** Result of a jcodeProviders:add / :list call. */
export type JcodeProviderActionResult = {
  ok: boolean
  /** Normalized error message when ok === false. */
  error?: string
  /** The persisted (non-secret) profile, on a successful add. */
  provider?: JcodeCustomProvider
}

export const JCODE_PROVIDERS_LIST_CHANNEL = 'jcodeProviders:list'
export const JCODE_PROVIDERS_ADD_CHANNEL = 'jcodeProviders:add'

export const JCODE_CHAT_SEND_CHANNEL = 'jcode-chat:send'
export const JCODE_CHAT_STOP_CHANNEL = 'jcode-chat:stop'
export const JCODE_CHAT_EVENT_CHANNEL = 'jcode-chat:event'

// ─── Durable persistence (BUG 1/2) ─────────────────────────────────────────
// jcode conversations are mirrored to disk in the main process so they survive
// app restart and a closed chat tab can be reopened + rehydrated. The renderer
// keeps its in-memory external store as the live layer; disk is the backing
// store. A conversation is keyed by `sessionKey` (the chat tab id), which the
// renderer recreates with a stable id on reopen so the keys line up.

/** A single persisted chat message (mirrors the renderer ChatMessage, but with
 *  the tool-call shape kept structural so shared code needn't import renderer
 *  types). Loosely typed `tools` because the tool-card shape lives in the
 *  renderer; the store round-trips it verbatim. */
export type JcodePersistedMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools?: unknown[]
  isError?: boolean
}

/** The full on-disk record for one conversation. */
export type JcodeConversationRecord = {
  /** Stable conversation id == the chat tab's sessionKey on first create. */
  sessionKey: string
  /** Worktree / folder-workspace key, so reopen can recreate the tab in place. */
  worktreeId?: string
  /** cwd the chat was launched with (best-effort; informational). */
  cwd?: string
  /** Human label for lists ("Recent chats"). Derived from the first user prompt. */
  title: string
  /** Last-activity timestamp (ms) for sorting recents. */
  updatedAt: number
  /** jcode --resume id so a reopened chat continues the same jcode session. */
  resumeSessionId?: string
  /** Persisted composer chip selection. */
  composerProvider?: string
  composerModel?: string
  /** Persisted custom provider profile selection (mutually exclusive with
   *  composerProvider; when set the chip points at a `jcode provider add` profile). */
  composerProviderProfile?: string
  /** The transcript. Capped to a max length on write to bound file growth. */
  messages: JcodePersistedMessage[]
}

/** Lightweight row returned by listConversations (no transcript body). */
export type JcodeConversationSummary = {
  sessionKey: string
  worktreeId?: string
  cwd?: string
  title: string
  updatedAt: number
  resumeSessionId?: string
}

export const JCODE_CHAT_LIST_CHANNEL = 'jcode-chat:listConversations'
export const JCODE_CHAT_LOAD_CHANNEL = 'jcode-chat:loadConversation'
export const JCODE_CHAT_DELETE_CHANNEL = 'jcode-chat:deleteConversation'
/** Renderer -> main: persist a snapshot of the live conversation state. */
export const JCODE_CHAT_SAVE_CHANNEL = 'jcode-chat:saveConversation'

/** Payload the renderer sends to persist a conversation snapshot. Sent on turn
 *  boundaries (start + done/error/stopped/exit), debounced, so we capture the
 *  full transcript and the latest --resume id without thrashing disk. */
export type JcodeChatSavePayload = {
  record: JcodeConversationRecord
}
