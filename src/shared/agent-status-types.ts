// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// These types define the normalized status that Orca receives from Claude,
// Codex, and other explicit integrations. Agent state is hook-reported only —
// we do not infer status from terminal titles anywhere in the data flow.

export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentStatusState = (typeof AGENT_STATUS_STATES)[number]
// Why: agent types are not restricted to a fixed set — new agents appear
// regularly and users may run custom agents. Any non-empty string is accepted;
// well-known names are kept as a convenience union for internal code that
// wants to pattern-match on common agents.
export type WellKnownAgentType =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'aider'
  | 'pi'
  | 'unknown'
export type AgentType = WellKnownAgentType | (string & {})

/** A snapshot of a previous agent state, used to render activity blocks.
 *  Why: intentionally narrower than AgentStatusEntry — omits toolName,
 *  toolInput, and lastAssistantMessage. History rows record what STATE the
 *  agent was in and what PROMPT was being handled; tool context is
 *  per-event/per-turn and doesn't meaningfully apply to a historical state
 *  snapshot. Carrying tool/assistant payloads on every transition would also
 *  bloat memory on long sessions (capped at AGENT_STATE_HISTORY_MAX entries
 *  per agent). The current state's tool/assistant fields live on
 *  AgentStatusEntry only, and activity-block rendering intentionally shows
 *  state + prompt + duration summaries rather than tool traces. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** True when this `done` was a cancellation (user hit ESC/Ctrl+C). Reported
   *  by the agent itself — Claude Code sets `is_interrupt: true` on its `Stop`
   *  hook when the turn ended via interrupt. Always falsy for non-`done`
   *  states, so retention logic can preserve this signal. */
  interrupted?: boolean
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20

export type AgentStatusEntry = {
  state: AgentStatusState
  /** The user's most recent prompt, when the hook payload carried one.
   *  Cached across the turn — subsequent tool-use events in the same turn do
   *  not include the prompt, so the renderer receives the last known value
   *  until a new prompt arrives or the pane resets. Empty when unknown. */
  prompt: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  /** Timestamp (ms) when the current `state` was first reported.
   *  Why: separate from updatedAt so stateHistory[].startedAt reflects when
   *  the state was first reported, not the most recent within-state update
   *  (tool/prompt pings reset updatedAt but not stateStartedAt). */
  stateStartedAt: number
  agentType?: AgentType
  /** Composite key: `${tabId}:${paneId}` — matches the cacheTimerByKey convention. */
  paneKey: string
  terminalTitle?: string
  /** Rolling log of previous states. Each entry records a state the agent was in
   *  before transitioning to the current one. Capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
  /** Name of the tool the agent is currently using (e.g. "Edit", "Bash"). */
  toolName?: string
  /** Short preview of the tool input (e.g. file path, command). */
  toolInput?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** True when the current `done` state was reached via an interrupt rather
   *  than a normal turn completion (Claude Code's `is_interrupt: true`).
   *  Orthogonal to `state`: the agent still finished the turn, but the user
   *  cancelled it. Undefined while the agent is working or for non-Claude
   *  agents that don't surface this signal. */
  interrupted?: boolean
}

// ─── Agent status payload shape (what hook receivers send via IPC) ──────────
// Hook integrations only need to provide normalized state fields. The
// remaining AgentStatusEntry fields (updatedAt, paneKey, etc.) are populated
// by the renderer when it receives the IPC event.

export type AgentStatusPayload = {
  state: AgentStatusState
  prompt?: string
  agentType?: AgentType
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
  interrupted?: boolean
}

/**
 * The result of `parseAgentStatusPayload`: prompt is always normalized to a
 * string (empty string when the raw payload omits it), so consumers do not
 * need nullish-coalescing on the field. Tool/assistant fields stay optional so
 * absence ("no new info") is distinguishable from an explicit empty string.
 */
export type ParsedAgentStatusPayload = Omit<AgentStatusPayload, 'prompt'> & { prompt: string }

/**
 * Wire shape for agent-status IPC. Both the push channel `agentStatus:set` and the
 * pull channel `agentStatus:getSnapshot` produce this shape so renderer call sites
 * can apply entries through a single `setAgentStatus` path. Flattens the parsed
 * payload onto pane identity + timing because the renderer's slice expects them
 * destructured.
 */
export type AgentStatusIpcPayload = ParsedAgentStatusPayload & {
  paneKey: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Stamped only on the remote-ingest path (Orca's `ingestRemote`); the
   *  HTTP path always sets null because it cannot know which mux a request
   *  came from. See docs/design/agent-status-over-ssh.md §5. */
  connectionId: string | null
  /** Timestamp (ms) when the hook server received this latest status event. */
  receivedAt: number
  /** Timestamp (ms) when the current state first appeared for this pane. */
  stateStartedAt: number
}

/** Maximum character length for the prompt field. Truncated on parse. */
export const AGENT_STATUS_MAX_FIELD_LENGTH = 200
/** Maximum character length for the toolName field. */
export const AGENT_STATUS_TOOL_NAME_MAX_LENGTH = 60
/** Maximum character length for the toolInput preview. */
export const AGENT_STATUS_TOOL_INPUT_MAX_LENGTH = 160
/** Maximum character length for the lastAssistantMessage preview.
 *  Why: assistant messages are the user-facing "what did the agent say" body,
 *  expanded inline in the dashboard row. 8 KB comfortably fits a multi-
 *  paragraph summary while still providing a hard upper bound — the hook
 *  HTTP endpoint already caps bodies at 1 MB, but per-field truncation is a
 *  second line of defense against a buggy/malicious agent spamming huge
 *  strings into the cache (which lives per pane with bounded history). */
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000
/**
 * Freshness threshold for explicit agent status. Retained past this point so
 * WorktreeCard's sidebar dot can decay "working" back to "active" when the
 * hook stream goes silent. Smart-sort + WorktreeCard still read this; the
 * dashboard + hover only display hook-reported data as-is.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

// Why: typed as ReadonlySet<string> so .has() accepts any string without
// requiring `state as AgentStatusState` at the check site. The narrowing
// cast stays on the return line, where it's actually proven safe.
const VALID_STATES: ReadonlySet<string> = new Set<string>(AGENT_STATUS_STATES)
/** Maximum character length for the agentType label. Truncated on parse. */
export const AGENT_TYPE_MAX_LENGTH = 40

// Why: when truncation lands mid surrogate-pair (emoji / astral chars), the
// high surrogate would be left dangling and render as the Unicode replacement
// glyph. Drop the lone high surrogate so the result is always a valid UTF-16
// sequence. Shared by the single-line and multiline normalizers so the
// protection can't drift between them.
function truncatePreservingSurrogates(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  let truncated = value.slice(0, maxLength)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    truncated = truncated.slice(0, -1)
  }
  return truncated
}

/** Normalize a status field: trim, collapse to single line, truncate. */
function normalizeField(value: unknown, maxLength: number = AGENT_STATUS_MAX_FIELD_LENGTH): string {
  if (typeof value !== 'string') {
    return ''
  }
  // Why: include Unicode line separators (U+2028, U+2029) in the collapse
  // set. A hook payload like "claude rogue" would otherwise bypass the
  // single-line invariant that downstream UI and equality checks rely on —
  // the data comes from an untrusted agent process.
  const singleLine = value.trim().replace(/[\r\n\u2028\u2029]+/g, ' ')
  return truncatePreservingSurrogates(singleLine, maxLength)
}

// Why: assistant messages are a multi-paragraph "what did the agent say"
// body that the dashboard renders with `whitespace-pre-wrap`. Collapsing
// newlines here would erase structure the UI is designed to show. Still
// normalize `\r\n` → `\n` and cap paragraph gaps at one blank line to keep
// the bound meaningful, but otherwise preserve line breaks.
function normalizeMultilineField(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  // Why: fold Unicode line/paragraph separators (U+2028, U+2029) into ordinary
  // `\n` before the blank-line-run cap. These code points render as real line
  // breaks under `whitespace-pre-wrap`, so leaving them untouched would let a
  // buggy/malicious agent bypass the `\n{3,}` → `\n\n` safeguard by spamming
  // arbitrarily many U+2029 paragraph breaks. Matches the single-line
  // normalizer's treatment of the same code points, keeping the two paths in
  // sync. Step order preserved: `\r\n` → `\n`, bare `\r` → `\n`,
  // U+2028/U+2029 → `\n`, then collapse blank-line runs.
  const normalized = value
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return truncatePreservingSurrogates(normalized, maxLength)
}

// Why: tool/assistant fields are optional on the entry (absence = "no update
// for this field"). We only surface them when the caller actually provided a
// string value so a missing field doesn't overwrite the prior cached state.
function normalizeOptionalField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

function normalizeOptionalMultilineField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = normalizeMultilineField(value, maxLength)
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Normalize and validate an already-parsed agent status object. Shared by the
 * JSON string entry point (`parseAgentStatusPayload`) and the object entry
 * point (`normalizeAgentStatusPayload`) so both paths enforce identical field
 * rules. Returns null when the payload is malformed or the state is invalid.
 */
function normalizeAgentStatusObject(parsed: unknown): ParsedAgentStatusPayload | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  // Why: explicit typeof guard ensures non-string values (e.g. numbers)
  // are rejected rather than relying on Set.has returning false for
  // mismatched types.
  if (typeof obj.state !== 'string') {
    return null
  }
  const state = obj.state
  if (!VALID_STATES.has(state)) {
    return null
  }
  return {
    state: state as AgentStatusState,
    prompt: normalizeField(obj.prompt),
    // Why: route through normalizeOptionalField so agentType gets the same
    // trim / collapse-newlines / truncate / empty→undefined treatment as the
    // other single-line string fields (toolName, toolInput, prompt). Inline
    // trim+slice left embedded newlines intact, which broke single-line UI
    // rendering and equality checks when a payload contained e.g.
    // `agentType: "claude\nrogue"`.
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    toolName: normalizeOptionalField(obj.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
    toolInput: normalizeOptionalField(obj.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    lastAssistantMessage: normalizeOptionalMultilineField(
      obj.lastAssistantMessage,
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    ),
    // Why: only meaningful on `done`. Coerce to undefined on other states so
    // the field doesn't leak stale truth through state transitions.
    interrupted: obj.interrupted === true && state === 'done' ? true : undefined
  }
}

/**
 * Normalize an already-structured agent status object (e.g. arriving via IPC
 * where the payload has already been deserialized by Electron). Skips the
 * JSON.stringify → JSON.parse round-trip that `parseAgentStatusPayload`
 * requires, which matters because hook events can fire many times per second
 * during a tool-use run.
 */
export function normalizeAgentStatusPayload(payload: unknown): ParsedAgentStatusPayload | null {
  return normalizeAgentStatusObject(payload)
}

/**
 * Parse and validate an agent status JSON payload received from explicit
 * hook integrations or OSC 9999. Returns null if the payload is malformed or
 * has an invalid state.
 */
export function parseAgentStatusPayload(json: string): ParsedAgentStatusPayload | null {
  try {
    return normalizeAgentStatusObject(JSON.parse(json))
  } catch {
    return null
  }
}
