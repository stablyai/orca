// ─── Explicit agent status (reported via native agent hooks → IPC) ──────────
// Why: status comes from hooks (Claude, Codex, etc.) — never inferred from terminal titles;
// a narrow interrupt fallback synthesizes a final `done` when an agent misses its cancellation hook.

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
// Why: agent types aren't a fixed set (custom agents exist); any non-empty string is
// accepted — these well-known names are just a convenience union for pattern-matching.
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
 *  Why: intentionally narrower than AgentStatusEntry — tool/assistant context is
 *  per-turn, not meaningful on a historical snapshot, and would bloat memory. */
export type AgentStateHistoryEntry = {
  state: AgentStatusState
  prompt: string
  /** When this state was first reported. */
  startedAt: number
  /** True when this `done` was a cancellation (agent hook like Claude `is_interrupt`,
   *  or Orca's guarded fallback). Always falsy for non-`done` states so retention logic can preserve it. */
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

/** A live in-process subagent/teammate of the pane's session (Claude Subagent hooks +
 *  the `background_tasks` field on Stop). Rendered as an indented child row with no PTY of its own. */
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
  /** The user's most recent prompt. Cached across the turn — later tool-use events
   *  omit it, so the last value persists until a new prompt or pane reset. Empty when unknown. */
  prompt: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  /** Timestamp (ms) when the current `state` was first reported.
   *  Why: separate from updatedAt so tool/prompt pings (which reset updatedAt) don't move it. */
  stateStartedAt: number
  agentType?: AgentType
  /** Composite key: `${tabId}:${leafId}` where leafId is a stable UUID layout leaf. */
  paneKey: string
  /** Runtime terminal handle for matching retained parent rows when the parent
   *  pane key cannot be re-derived after terminal teardown. */
  terminalHandle?: string
  /** Worktree attribution stamped by main when a hook resolves there.
   *  Why: orchestration workers can report before their tab exists in a renderer, so retaining this keeps them attributed instead of dropped. */
  worktreeId?: string
  /** Accepted transport authority for this live row; null means local. */
  connectionId?: string | null
  /** Tab attribution from the hook IPC payload, when available. */
  tabId?: string
  terminalTitle?: string
  /** Rolling log of previous states, capped at AGENT_STATE_HISTORY_MAX. */
  stateHistory: AgentStateHistoryEntry[]
  /** Name of the tool the agent is currently using (e.g. "Edit", "Bash"). */
  toolName?: string
  /** Short preview of the tool input (e.g. file path, command). */
  toolInput?: string
  /** JSON of the AskUserQuestion tool input, captured live; unlike toolInput it's not
   *  truncated (clients render the full card). Cleared once the agent moves on so a stale prompt can't linger. */
  interactivePrompt?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** True when this `done` was reached via interrupt, not normal completion
   *  (agent-reported or Orca's guarded fallback). Undefined otherwise. */
  interrupted?: boolean
  /** Orchestration dispatch context for panes spawned by another agent.
   *  Why: parent/child hierarchy is pane-level state, not worktree lineage — workers often share the coordinator's worktree. */
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
// Hook integrations provide only normalized state fields; the renderer fills the rest (updatedAt, paneKey, …) on IPC receipt.

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
 * Result of `parseAgentStatusPayload`: prompt is always a string (empty when omitted) so
 * consumers needn't nullish-coalesce; tool/assistant fields stay optional to distinguish
 * absence ("no new info") from an explicit empty string.
 */
export type ParsedAgentStatusPayload = Omit<AgentStatusPayload, 'prompt'> & { prompt: string }

/**
 * Wire shape for agent-status IPC. Both `agentStatus:set` and `agentStatus:getSnapshot`
 * produce this shape so renderer call sites share a single `setAgentStatus` path.
 */
export type AgentStatusIpcPayload = ParsedAgentStatusPayload & {
  paneKey: string
  launchToken?: string
  terminalHandle?: string
  tabId?: string
  worktreeId?: string
  /** Identifies the SSH connection the event arrived on, or null for local.
   *  Only the remote-ingest path (`ingestRemote`) can stamp it; the HTTP path always sets null. See docs/design/agent-status-over-ssh.md §5. */
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
 *  Why: 8 KB fits a multi-paragraph summary while bounding per-pane cache against a buggy/malicious agent spamming huge strings. */
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000
/** Maximum character length for the interactivePrompt field.
 *  Why: holds full AskUserQuestion JSON — truncating to a preview like toolInput would corrupt it and drop options; capped to still bound cache growth. */
export const AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH = 16000
/**
 * Freshness threshold for explicit agent status: retained past this so WorktreeCard's
 * sidebar dot can decay "working" back to "active" when the hook stream goes silent.
 */
export const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1000

export function isFreshNonDoneAgentStatus(
  entry: Pick<AgentStatusEntry, 'state' | 'updatedAt'> | undefined,
  now = Date.now(),
  staleAfterMs = AGENT_STATUS_STALE_AFTER_MS
): boolean {
  return Boolean(entry && entry.state !== 'done' && now - entry.updatedAt <= staleAfterMs)
}

// Why: ReadonlySet<string> so .has() accepts any string without a cast here; the narrowing cast stays on the return line where it's proven safe.
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
  // Why: explicit typeof guard rejects non-string values instead of leaning on Set.has to return false for mismatched types.
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
    // Why: normalize like the other single-line fields so embedded newlines (e.g. `agentType: "claude\nrogue"`) can't break single-line UI and equality checks.
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
    // Why: only meaningful on `done`; coerce to undefined elsewhere so it can't leak stale truth across transitions.
    interrupted: obj.interrupted === true && state === 'done' ? true : undefined,
    subagents: normalizeSubagentsField(obj.subagents)
  }
}

/**
 * Normalize an already-structured agent status object (e.g. from IPC, already
 * deserialized by Electron). Skips the JSON round-trip parseAgentStatusPayload
 * needs — hook events can fire many times per second during a tool-use run.
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
