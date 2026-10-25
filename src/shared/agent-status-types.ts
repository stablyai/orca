// Normalize explicit hook/OSC status; a guarded interrupt fallback supplies done when the cancellation hook is missing.

import type { ProgramStatusFacet } from './program-status/facet'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentMainAgentStatus } from './main-agent-status'
import type { AgentStateHistoryEntry } from './agent-state-history'
import { isAgentTurnOutcome } from './agent-turn-outcome'
import type { OrchestrationFleetAttention } from './orchestration-fleet-attention'
import type { AgentStatusRowFacets } from './agent-status-observation'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { TerminalAgent } from './terminal-agent'
import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeInteractivePromptField,
  normalizeOptionalField,
  normalizeOptionalMultilineField,
  normalizePromptField,
  normalizeTurnCompletedAtField
} from './agent-status-field-normalization'
import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'

import {
  normalizeAgentSubagentsField,
  type AgentSubagentSnapshot
} from './agent-status-subagent-snapshot'

export {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from './agent-status-field-normalization'
export {
  agentSubagentsEqual,
  type AgentSubagentSnapshot,
  type AgentSubagentState
} from './agent-status-subagent-snapshot'
export type {
  AgentStatusCacheIdentity,
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from './agent-status-ipc-payload'
export { mainAgentStatusEqual, type AgentMainAgentStatus } from './main-agent-status'
export { AGENT_STATE_HISTORY_MAX, type AgentStateHistoryEntry } from './agent-state-history'

export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentStatusState = (typeof AGENT_STATUS_STATES)[number]
export type AgentWorkingMode = 'monitoring'

// Accept custom nonempty agent names; the well-known TerminalAgent/unknown union is only a pattern-matching convenience.
export type WellKnownAgentType = TerminalAgent | 'unknown'
export type AgentType = WellKnownAgentType | (string & {})

export type AgentStatusOrchestrationContext = {
  taskId: string
  dispatchId: string
  /** Runtime-authoritative lifecycle state. Hook-only contexts may omit it. */
  dispatchStatus?: 'pending' | 'dispatched' | 'completed' | 'failed' | 'circuit_broken'
  taskTitle?: string
  displayName?: string
  parentTerminalHandle?: string
  parentPaneKey?: string
  coordinatorHandle?: string
  orchestrationRunId?: string
  /** Durable orchestration categories combined with the current push-fed status observation. */
  attention?: OrchestrationFleetAttention
}

export type AgentStatusEntry = {
  /** Renderer-local status-feed confirmation for children; absent on hook rows. */
  subagentObservation?: 'live' | 'unverifiable'
  state: AgentStatusState
  /** Ongoing work that does not require foreground agent execution. Only valid while working. */
  workingMode?: AgentWorkingMode
  /** Cache the latest prompt across tool events until a new prompt/reset; empty means unknown. */
  prompt: string
  /** Timestamp (ms) of the last status update. */
  updatedAt: number
  /** Original evidence clock; delivery updatedAt restamps reconnect replays. Local/older-host rows omit this and use updatedAt for freshness. */
  evidenceObservedAt?: number
  /** True only while a host-held structured session is represented by its live status feed. */
  structuredHostOwned?: true
  /** State entry time stays fixed while tool/prompt pings advance updatedAt. */
  stateStartedAt: number
  /** `updatedAt` of the write that switched into `state`; see AgentStateHistoryEntry.observedAt. */
  stateObservedAt?: number
  /** Host-stamped lead turn opening; older hosts/writers without turn clocks fall back to stateStartedAt. */
  turnStartedAt?: number
  /** The host's turn-end stamp; see `AgentStatusIpcPayload.turnEndedAt`. */
  turnEndedAt?: number
  /** How the host identified that end; see `TurnEndDisposition`. */
  turnEndDisposition?: TurnEndDisposition
  agentType?: AgentType
  /** Provider model currently used by this session. */
  model?: string
  /** Command installed by the running OMP extension; absent on older hosts. */
  modelSwitchCommand?: 'orca-model'
  /** Composite key: `${tabId}:${leafId}` where leafId is a stable UUID layout leaf. */
  paneKey: string
  /** Runtime terminal handle for matching retained parent rows when the parent
   *  pane key cannot be re-derived after terminal teardown. */
  terminalHandle?: string
  /** Retain host workspace attribution for orchestration workers reporting before their renderer tab exists. */
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
  /** Keep full AskUserQuestion JSON for cards, not toolInput previews; clear when the agent moves on. */
  interactivePrompt?: string
  /** Most recent assistant message preview, when the hook carried one. */
  lastAssistantMessage?: string
  /** Dashboard may show tool output, but native-chat streaming must not present tool stdout as assistant prose. */
  lastAssistantMessageIsToolOutput?: boolean
  /** Retain the last completed non-boundary output across working: batched done→working publication may already clear lastAssistantMessage. */
  lastCompletedAssistantMessage?: string
  /** True when this `done` was reached via interrupt, not normal completion
   *  (agent-reported or Orca's guarded fallback). Undefined otherwise. */
  interrupted?: boolean
  /** True when this `done` is a session boundary, not a completed turn. See AgentStatusPayload. */
  sessionBoundary?: boolean
  /** Dispatch hierarchy belongs to panes, not worktrees: workers can share the coordinator's worktree. */
  orchestration?: AgentStatusOrchestrationContext
  /** Live in-process subagents/teammates of this pane's session. Absent when
   *  none are tracked; the sidebar derives indented child rows from it. */
  subagents?: AgentSubagentSnapshot[]
  /** The main agent's own state; absent from old hosts and from writers that carry no main agent fact
   *  (OSC, launch seeds), where readers fall back to `state`. */
  mainAgent?: AgentMainAgentStatus
  /** The host's child-work views for this session, when it publishes them; child rows then read
   *  these instead of `subagents`. Absent from older hosts. */
  children?: AgentChildWorkView[]
  /** Provider-owned conversation/session id captured from hook payloads.
   *  Used only for exact CLI resume; Orca terminal ids are not agent-session ids. */
  providerSession?: AgentProviderSessionMetadata
  /** False when the status belongs to a non-terminal owner that restores itself. */
  terminalResumeEligible?: false
  /** Live-only Command Code turn boundary key; not persisted to last-status.json. */
  promptInteractionKey?: string
  /** Live OSC 7501 facet never decides state; read through resolveProgramStatusPresentation beside the state owner. */
  programStatus?: ProgramStatusFacet
  /** Hydrated nonterminal rows are immediately stale; accepted live events clear this flag.
   * Hosts also use it for pre-process evidence: preserve identity without claiming current status. */
  restoredUnconfirmed?: boolean
} & AgentStatusRowFacets

// ─── Agent status payload shape (what hook receivers send via IPC) ──────────
// Hook integrations provide only normalized state fields; the renderer fills the rest (updatedAt, paneKey, …) on IPC receipt.

export type AgentStatusPayload = {
  state: AgentStatusState
  /** Ongoing work that does not require foreground agent execution. Only valid while working. */
  workingMode?: AgentWorkingMode
  prompt?: string
  agentType?: AgentType
  model?: string
  modelSwitchCommand?: 'orca-model'
  toolName?: string
  toolInput?: string
  /** JSON string of the AskUserQuestion tool input, captured live. See the
   *  AgentStatusEntry field for semantics. Not truncated like toolInput. */
  interactivePrompt?: string
  lastAssistantMessage?: string
  /** See the AgentStatusEntry field for semantics. */
  lastAssistantMessageIsToolOutput?: boolean
  interrupted?: boolean
  /** done session boundaries (connect/resume/clear) are not turn completions; notifications/automations/badges/end clocks must ignore them (STA-3386). */
  sessionBoundary?: boolean
  /** Wall-clock ms when the lead turn ended while Claude background inventory kept the pane `working`.
   *  `stateStartedAt` stays pinned for that whole working run, so this is the per-turn identity.
   *  Present on the gated `working` row and that turn's later all-clear `done`. Event-only — not stored on AgentStatusEntry. */
  turnCompletedAt?: number
  /** Live in-process children of the reporting session. See AgentStatusEntry. */
  subagents?: AgentSubagentSnapshot[]
  /** The main agent's own state and last-turn verdict. See AgentMainAgentStatus. Producers publish it
   *  beside the combined `state`; a reader that predates it keeps reading `state`. */
  mainAgent?: AgentMainAgentStatus
  /** The execution host awaits a launched Claude task’s wake-up or its finishing turn. */
  claudeTaskWakeupPending?: 'notification' | 'finishing-turn'
}

/** Parsing always supplies prompt (empty if omitted); optional tool/assistant fields distinguish no update from explicit clearing. */
export type ParsedAgentStatusPayload = Omit<AgentStatusPayload, 'prompt'> & { prompt: string }

/** Explicitly select status fields from flattened IPC; spreading would leak launchToken, connectionId, promptInteractionKey and providerSessionOnly to paired clients. */
export function pickParsedAgentStatusPayload(
  row: ParsedAgentStatusPayload
): ParsedAgentStatusPayload {
  return {
    state: row.state,
    ...(row.workingMode !== undefined ? { workingMode: row.workingMode } : {}),
    prompt: row.prompt,
    ...(row.agentType !== undefined ? { agentType: row.agentType } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.modelSwitchCommand ? { modelSwitchCommand: row.modelSwitchCommand } : {}),
    ...(row.toolName !== undefined ? { toolName: row.toolName } : {}),
    ...(row.toolInput !== undefined ? { toolInput: row.toolInput } : {}),
    ...(row.interactivePrompt !== undefined ? { interactivePrompt: row.interactivePrompt } : {}),
    ...(row.lastAssistantMessage !== undefined
      ? { lastAssistantMessage: row.lastAssistantMessage }
      : {}),
    ...(row.lastAssistantMessageIsToolOutput !== undefined
      ? { lastAssistantMessageIsToolOutput: row.lastAssistantMessageIsToolOutput }
      : {}),
    ...(row.interrupted !== undefined ? { interrupted: row.interrupted } : {}),
    ...(row.sessionBoundary !== undefined ? { sessionBoundary: row.sessionBoundary } : {}),
    ...(row.turnCompletedAt !== undefined ? { turnCompletedAt: row.turnCompletedAt } : {}),
    ...(row.subagents !== undefined ? { subagents: row.subagents } : {}),
    ...(row.mainAgent !== undefined ? { mainAgent: row.mainAgent } : {}),
    ...(row.claudeTaskWakeupPending !== undefined
      ? { claudeTaskWakeupPending: row.claudeTaskWakeupPending }
      : {})
  }
}

/** Hook set/snapshot IPC shares one shape so renderers use one setAgentStatus path. */
/** Maximum character length for the toolName field. */
export const AGENT_STATUS_TOOL_NAME_MAX_LENGTH = 60
/** 8KB preserves paragraph summaries while bounding per-pane cache growth. */
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000
/** Keep full question JSON/options, with a cap to bound cache; preview cuts would corrupt it. */
export const AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH = 16000
// Re-exported here because every consumer reaches for the entry type and its freshness gate
// together; the clock rules themselves live in agent-status-freshness.ts.
export {
  AGENT_STATUS_HYDRATE_MAX_AGE_MS,
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusAuthorityObservedAt,
  agentStatusEvidenceObservedAt,
  isFreshNonDoneAgentStatus
} from './agent-status-freshness'

// Why: ReadonlySet<string> so .has() accepts any string without a cast here; the narrowing cast stays on the return line where it's proven safe.
const VALID_STATES: ReadonlySet<string> = new Set<string>(AGENT_STATUS_STATES)

/** identified proves a new/continued/repeated turn; ambiguous cannot distinguish repeats from missed openings. Absence is legacy (older hosts, replays, unclassified agents). */
export type TurnEndDisposition = 'identified' | 'ambiguous'

export type HostTurnEndFacts = { turnEndedAt?: number; turnEndDisposition?: TurnEndDisposition }

export function isTurnEndDisposition(value: unknown): value is TurnEndDisposition {
  return value === 'identified' || value === 'ambiguous'
}

/** The host's turn-end facts of a row, for the copies that carry them. */
export function pickHostTurnEnd(row: HostTurnEndFacts): HostTurnEndFacts {
  return {
    ...(row.turnEndedAt !== undefined ? { turnEndedAt: row.turnEndedAt } : {}),
    ...(row.turnEndDisposition !== undefined ? { turnEndDisposition: row.turnEndDisposition } : {})
  }
}

export function isAgentStatusState(value: unknown): value is AgentStatusState {
  return typeof value === 'string' && VALID_STATES.has(value)
}

export const AGENT_STATUS_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 4096,
  nestingDepth: 16
} as const

/** Drop malformed mainAgent alone; combined state remains valid, matching the older-host fallback. */
export function normalizeMainAgentStatusField(value: unknown): AgentMainAgentStatus | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const obj = value as Record<string, unknown>
  const state = obj.state
  if (!isAgentStatusState(state)) {
    return undefined
  }
  if (typeof obj.stateStartedAt !== 'number' || !Number.isFinite(obj.stateStartedAt)) {
    return undefined
  }
  return {
    state,
    // Why: a verdict belongs to a finished turn; anything riding on a live state is stale.
    ...(state === 'done' && isAgentTurnOutcome(obj.outcome) ? { outcome: obj.outcome } : {}),
    ...(state === 'working' && obj.stopping === true ? { stopping: true as const } : {}),
    stateStartedAt: obj.stateStartedAt
  }
}

/** Apply identical validation to JSON/object entrypoints; return null for malformed payloads or invalid states. */
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
    workingMode: state === 'working' && obj.workingMode === 'monitoring' ? 'monitoring' : undefined,
    prompt: normalizePromptField(obj.prompt),
    // Why: normalize like the other single-line fields so embedded newlines (e.g. `agentType: "claude\nrogue"`) can't break single-line UI and equality checks.
    agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
    model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
    ...(obj.modelSwitchCommand === 'orca-model'
      ? { modelSwitchCommand: 'orca-model' as const }
      : {}),
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
    // Only explicit true means known tool output; absent/false retain older-host behavior without suppressing prose.
    lastAssistantMessageIsToolOutput:
      obj.lastAssistantMessageIsToolOutput === true ? true : undefined,
    // Why: only meaningful on `done`; coerce to undefined elsewhere so it can't leak stale truth across transitions.
    interrupted: obj.interrupted === true && state === 'done' ? true : undefined,
    sessionBoundary: obj.sessionBoundary === true && state === 'done' ? true : undefined,
    turnCompletedAt: normalizeTurnCompletedAtField(obj.turnCompletedAt, state),
    subagents: normalizeAgentSubagentsField(obj.subagents),
    mainAgent: normalizeMainAgentStatusField(obj.mainAgent),
    ...(obj.agentType === 'claude' &&
    state !== 'done' &&
    (obj.claudeTaskWakeupPending === 'notification' ||
      obj.claudeTaskWakeupPending === 'finishing-turn')
      ? { claudeTaskWakeupPending: obj.claudeTaskWakeupPending }
      : {})
  }
}

/** Normalize deserialized IPC directly to avoid JSON round trips on frequent tool events. */
export function normalizeAgentStatusPayload(payload: unknown): ParsedAgentStatusPayload | null {
  return normalizeAgentStatusObject(payload)
}

/** Reject malformed hook/OSC 9999 JSON or invalid states as null. */
export function parseAgentStatusPayload(json: string): ParsedAgentStatusPayload | null {
  try {
    assertJsonTextStructureWithinLimits(json, AGENT_STATUS_JSON_STRUCTURE_LIMITS)
    return normalizeAgentStatusObject(JSON.parse(json))
  } catch {
    return null
  }
}
