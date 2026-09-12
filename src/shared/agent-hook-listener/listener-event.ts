import type { ParsedAgentStatusPayload } from '../agent-status-types'
import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProviderSessionMetadata } from '../agent-session-resume'
import type { AgentStatusSubject } from '../agent-status-subject'

export type AgentHookEventPayload = {
  /** Required once the event enters the canonical store; absent only at legacy ingress. */
  subject?: AgentStatusSubject
  paneKey: string
  /** Authenticated hook route that produced this event. */
  source?: AgentHookSource
  /** Ephemeral Orca launch identity stamped into the PTY env for this process. */
  launchToken?: string
  tabId?: string
  worktreeId?: string
  /** SSH connection the event arrived on, or null for local. Only `ingestRemote` can stamp it — the loopback HTTP path has no mux identity — and receivers key off it to drop
   *  in-flight events from a superseded connection after an SSH reconnect. */
  connectionId: string | null
  /** True when the event carried prompt text directly, not the listener's cached prompt from an earlier event in the pane. */
  hasExplicitPrompt?: boolean
  /** The emitted nonterminal state is backed only by child state restored from disk. */
  restoredUnconfirmed?: true
  /** Stable per-turn key to distinguish duplicate hook delivery from a same-text prompt rerun (when the source exposes enough context). */
  promptInteractionKey?: string
  /** Raw agent hook event name, used by main-process transition guards. */
  hookEventName?: string
  /** Claude's provider-owned user-prompt UUID. */
  providerPromptId?: string
  /** Active Claude compact generation, keyed by provider prompt identity. */
  compactTrigger?: 'manual' | 'auto'
  /** Claude tool-use identifier when the hook source exposes one. */
  toolUseId?: string
  /** Claude agent/subagent identifier when the hook source exposes one. */
  toolAgentId?: string
  /** Claude teammate name carried by TeammateIdle. */
  teammateName?: string
  /** Agent/subagent type from the source hook payload, when present. */
  toolAgentType?: string
  /** Provider-owned conversation/session id needed to resume a sleeping agent. */
  providerSession?: AgentProviderSessionMetadata
  /** Session identity update with no turn-state transition; refreshes durable resume metadata without a fake status row. */
  providerSessionOnly?: boolean
  /** True when this event is a relay cache replay rather than a live hook. */
  isReplay?: boolean
  /** Transport-only Claude background-work evidence used to reject false input-based interrupts. */
  claudeRunningNonAgentTask?: boolean
  /** Row projected from a structured session the host holds: `owned` while its provider child
   *  runs here, `held` once the child is gone but the session is still open. Never persisted. */
  structuredHost?: StructuredHostStatus
  /** Runtime terminal handle the pane resolved to when main parsed this status off the PTY.
   *  Lets a reader rejoin the row to its terminal after the pane key moved. Never persisted:
   *  a handle belongs to the runtime that issued it. */
  terminalHandle?: string
  payload: ParsedAgentStatusPayload
}

export type StructuredHostStatus = 'held' | 'owned'
export type ToolSnapshot = {
  toolName?: string
  toolInput?: string
  /** Full JSON of an AskUserQuestion tool input; set only on its own event and NOT inherited (resolveToolState) so no stale prompt lingers. */
  interactivePrompt?: string
  hasToolUpdate?: boolean
  hasToolInputField?: boolean
  lastAssistantMessage?: string
  /** True when `lastAssistantMessage` was taken from a tool result/error rather than
   *  assistant prose. Status cards still show it; the native-chat streaming bubble
   *  must not, or a tool's stdout renders as the agent's reply. */
  lastAssistantMessageIsToolOutput?: boolean
  clearLastAssistantMessage?: boolean
}
