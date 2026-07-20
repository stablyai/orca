// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// These types define the normalized status that Orca receives from Claude,
// Codex, and other explicit integrations. Agent state normally comes from
// hooks; a narrow interrupt fallback may synthesize a final done state when an
// agent misses its own cancellation hook. We still do not infer status from
// terminal titles anywhere in the data flow.

import type { AgentProviderSessionMetadata } from './agent-session-resume'
import {
  normalizeInteractivePromptField,
  normalizeOptionalField,
  normalizeOptionalMultilineField,
  normalizePromptField
} from './agent-status-field-normalization'

export { AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-field-normalization'

export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentStatusState = (typeof AGENT_STATUS_STATES)[number]
// Why: agent types are not restricted to a fixed set — new agents appear
// regularly and users may run custom agents. Any non-empty string is accepted;
// well-known names are kept as a convenience union for internal code that
// wants to pattern-match on common agents.
export type WellKnownAgentType =
  | 'claude'
  | 'openclaude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'amp'
  | 'opencode'
  | 'mimo-code'
  | 'cursor'
  | 'copilot'
  | 'aider'
  | 'pi'
  | 'omp'
  | 'droid'
  | 'command-code'
  | 'grok'
  | 'hermes'
  | 'devin'
  | 'ante'
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
  /** True when this `done` was a cancellation. May come from an agent hook
   *  (for example Claude Code `is_interrupt`) or Orca's guarded interrupt
   *  fallback. Always falsy for non-`done` states, so retention logic can
   *  preserve this signal. */
  interrupted?: boolean
}

/** Maximum number of history entries kept per agent to bound memory. */
export const AGENT_STATE_HISTORY_MAX = 20

export type AgentStatusOrchestrationContext = {
  taskId: string
  dispatchId: string
  taskTitle?: string
  displayName?: string
  parentTerminalHandle?: string
  parentPaneKey?: string
  coordinatorHandle?: string
  orchestrationRunId?: string
}

export type AgentSubagentState = 'working' | 'idle'

/** A live in-process subagent/teammate spawned by the pane's agent session
 *  (reported by Claude's SubagentStart/SubagentStop hooks and the
 *  `background_tasks` field on Stop). Rendered as an indented child row under
 *  the owning pane's sidebar row — these children have no PTY of their own. */
export type AgentSubagentSnapshot = {
  /** Provider-assigned id (Claude hook `agent_id`). */
  id: string
  agentType?: string
  description?: string
  state: AgentSubagentState
  /** Timestamp (ms) when this subagent was first observed. */
  startedAt: number
}

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
  /** Composite key: `${tabId}:${leafId}` where leafId is a stable UUID layout leaf. */
  paneKey: string
  /** Runtime terminal handle for matching retained parent rows when the parent
   *  pane key cannot be re-derived after terminal teardown. */
  terminalHandle?: string
  /** Worktree attribution stamped by main when a hook can be resolved there.
   *  Why: orchestration workers can report status before their terminal tab is
   *  present in a renderer; retaining this lets worktree-level UI still show
   *  the live child agent instead of dropping it as unattributed. */
  worktreeId?: string
  /** Accepted transport authority for this live row; null means local. */
  connectionId?: string | null
  /** Tab attribution from the hook IPC payload, when available. */
  tabId?: string
  terminalTitle?: string
  /** Rolling log of previous states. Each entry records a state the agent was in
   *  before transitioning to the current one. Capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
  /** Name of the tool the agent is currently using (e.g. "Edit", "Bash"). */
  toolName?: string
  /** Short preview of the tool input (e.g. file path, command). */
  toolInput?: string
  /** JSON string of the AskUserQuestion tool input (`{ questions: [...] }`),
   *  captured live when the agent calls AskUserQuestion. Unlike toolInput this
   *  is NOT truncated to a short preview — clients render the full structured
   *  prompt as a live card. Cleared (undefined) once the agent moves on to a
   *  different tool or state so a stale prompt doesn't linger. */
  interactivePrompt?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** True when the current `done` state was reached via an interrupt rather
   *  than a normal turn completion. May be reported by the agent itself or
   *  inferred by Orca's guarded interrupt fallback.
   *  Orthogonal to `state`: the agent still finished the turn, but the user
   *  cancelled it. Undefined while the agent is working or when no interrupt
   *  signal was available. */
  interrupted?: boolean
  /** Orchestration dispatch context for agent panes spawned by another agent.
   *  Why: parent/child agent hierarchy is pane-level state, not worktree
   *  lineage; workers often run in the same worktree as their coordinator. */
  orchestration?: AgentStatusOrchestrationContext
  /** Live in-process subagents/teammates of this pane's session. Absent when
   *  none are tracked; the sidebar derives indented child rows from it. */
  subagents?: AgentSubagentSnapshot[]
  /** Provider-owned conversation/session id captured from hook payloads.
   *  Used only for exact CLI resume; Orca terminal ids are not agent-session ids. */
  providerSession?: AgentProviderSessionMetadata
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
}

export type MigrationUnsupportedPtyEntry = {
  ptyId: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  /** Registry-backed UUID pane proof, when available. */
  paneKey?: string
  reason: 'legacy-numeric-pane-key'
  source: 'local' | 'ssh'
  updatedAt: number
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
  /** JSON string of the AskUserQuestion tool input, captured live. See the
   *  AgentStatusEntry field for semantics. Not truncated like toolInput. */
  interactivePrompt?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  /** Live subagents/teammates of the reporting session. See AgentStatusEntry. */
  subagents?: AgentSubagentSnapshot[]
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
  launchToken?: string
  terminalHandle?: string
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
  orchestration?: AgentStatusOrchestrationContext
  providerSession?: AgentProviderSessionMetadata
  /** Resume identity update only; the status-shaped fields are transport placeholders. */
  providerSessionOnly?: boolean
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
}

/** Wire shape for ordinary pane teardown or a stamped SSH disconnect batch. */
export type AgentStatusClearIpcPayload =
  | { paneKey: string }
  | {
      transient: true
      connectionId: string
      clearedAt: number
    }

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
/** Maximum character length for the interactivePrompt field.
 *  Why: this holds the full JSON of an AskUserQuestion tool input
 *  (`{ questions: [...] }`), which clients render as a structured live card —
 *  truncating to a 160-char preview like toolInput would corrupt the JSON and
 *  drop options. Capped generously so multi-question prompts survive intact
 *  while still bounding per-pane cache growth from a buggy/malicious agent. */
export const AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH = 16000
/**
 * Freshness threshold for explicit agent status. Retained past this point so
 * WorktreeCard's sidebar dot can decay "working" back to "active" when the
 * hook stream goes silent. Smart-sort + WorktreeCard still read this; the
 * dashboard + hover only display hook-reported data as-is.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

export function isFreshNonDoneAgentStatus(
  entry: Pick<AgentStatusEntry, 'state' | 'updatedAt'> | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  return Boolean(entry && entry.state !== 'done' && now - entry.updatedAt <= staleAfterMs)
}

// Why: typed as ReadonlySet<string> so .has() accepts any string without
// requiring `state as AgentStatusState` at the check site. The narrowing
// cast stays on the return line, where it's actually proven safe.
const VALID_STATES: ReadonlySet<string> = new Set<string>(AGENT_STATUS_STATES)
/** Maximum character length for the agentType label. Truncated on parse. */
export const AGENT_TYPE_MAX_LENGTH = 40

/** Maximum subagent child rows carried per status entry. Bounds per-pane cache
 *  and IPC fanout against a runaway spawner. */
export const AGENT_STATUS_MAX_SUBAGENTS = 32
const AGENT_SUBAGENT_ID_MAX_LENGTH = 64

function normalizeSubagentSnapshot(value: unknown): AgentSubagentSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id !== 'string') {
    return null
  }
  const id = obj.id.trim()
  if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return null
  }
  if (obj.state !== 'working' && obj.state !== 'idle') {
    return null
  }
  return {
    id,
    state: obj.state,
    startedAt:
      typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    description: normalizeOptionalField(obj.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  }
}

function normalizeSubagentsField(value: unknown): AgentSubagentSnapshot[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  const normalized: AgentSubagentSnapshot[] = []
  for (const item of value) {
    const snapshot = normalizeSubagentSnapshot(item)
    if (snapshot) {
      normalized.push(snapshot)
      if (normalized.length >= AGENT_STATUS_MAX_SUBAGENTS) {
        break
      }
    }
  }
  return normalized.length > 0 ? normalized : undefined
}

/** Structural equality for subagent lists so stores can reuse the previous
 *  array reference (and skip fanout) when nothing actually changed. */
export function agentSubagentsEqual(
  a: AgentSubagentSnapshot[] | undefined,
  b: AgentSubagentSnapshot[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return !a && !b
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.startedAt !== y.startedAt ||
      x.agentType !== y.agentType ||
      x.description !== y.description
    ) {
      return false
    }
  }
  return true
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
    prompt: normalizePromptField(obj.prompt),
    // Why: route through normalizeOptionalField so agentType gets the same
    // trim / collapse-newlines / truncate / empty→undefined treatment as the
    // other single-line string fields (toolName, toolInput, prompt). Inline
    // trim+slice left embedded newlines intact, which broke single-line UI
    // rendering and equality checks when a payload contained e.g.
    // `agentType: "claude\nrogue"`.
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    toolName: normalizeOptionalField(obj.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
    toolInput: normalizeOptionalField(obj.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
    interactivePrompt: normalizeInteractivePromptField(
      obj.interactivePrompt,
      AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
    ),
    lastAssistantMessage: normalizeOptionalMultilineField(
      obj.lastAssistantMessage,
      AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH
    ),
    // Why: only meaningful on `done`. Coerce to undefined on other states so
    // the field doesn't leak stale truth through state transitions.
    interrupted: obj.interrupted === true && state === 'done' ? true : undefined,
    subagents: normalizeSubagentsField(obj.subagents)
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
