/**
 * Shared types for the duplex voice control: one OpenAI Realtime session the user talks
 * to, routed to worktree agents through orchestration. Main owns credentials and the
 * sideband control socket; the renderer owns only the WebRTC peer connection, so nothing
 * secret and no raw audio ever crosses IPC.
 */

export type VoiceControlState = 'idle' | 'minting' | 'awaiting-sdp' | 'live' | 'stopping' | 'error'

/** Classified failure surface; each kind maps to a distinct renderer remedy. */
export type VoiceControlErrorKind =
  | 'tls-intercept'
  | 'network'
  | 'auth'
  | 'quota'
  | 'unavailable'
  | 'unknown'
  | 'mic-denied'
  | 'key-missing'
  /** A key file exists but cannot be decrypted (e.g. sealed under another app identity). */
  | 'key-unreadable'
  | 'ice-failed'

/**
 * How relayed agent updates are attributed — NOT timbre: the provider locks a session's
 * voice once the first reply plays, so per-agent voices are impossible mid-session.
 * 'per-agent' = relays name the reporting agent; 'coordinator' = first-person, unnamed.
 */
export type VoiceControlAgentVoiceMode = 'per-agent' | 'coordinator'

export type VoiceControlSettings = {
  /** Feature gate; off by default. */
  enabled: boolean
  coordinatorVoice: OpenAiRealtimeVoice
  agentVoiceMode: VoiceControlAgentVoiceMode
  /** Auto-hangup budget; realtime audio bills per minute. */
  maxSessionMinutes: number
  /** Free-form persona/style notes appended after the core instructions; applies to new sessions. */
  customInstructions: string
}

/** The voices gpt-realtime speaks with. Coordinator defaults to `marin`. */
export const OPENAI_REALTIME_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'cedar',
  'echo',
  'marin',
  'sage',
  'shimmer',
  'verse'
] as const

export type OpenAiRealtimeVoice = (typeof OPENAI_REALTIME_VOICES)[number]

export type VoiceControlStateChangedEvent = {
  sessionId: string | null
  state: VoiceControlState
  errorKind?: VoiceControlErrorKind
  error?: string
}

/**
 * A tool dispatch the pill may narrate. The renderer maps `tool` to its own localized
 * copy — model-facing tool output strings never reach the UI. `target` is the resolved
 * agent's spoken name when one is involved; `detail` is internal diagnostics only.
 */
export type VoiceControlToolActivityEvent = {
  sessionId: string
  tool: string
  target?: string
  detail?: string
}

/** Per-agent activity for the overlay chips. */
export type VoiceControlAgentActivityEvent = {
  sessionId: string
  paneKey: string
  activity: 'thinking' | 'speaking' | 'idle'
  /** Roster display name for the chip; omitted on idle (the renderer deletes the chip). */
  spokenName?: string
}

/** The control's realtime function-tool names — the session config (main) and the
 * pill's activity labels (renderer) must agree on this wire contract. */
export const LIST_AGENTS_TOOL_NAME = 'list_agents'
export const MESSAGE_AGENT_TOOL_NAME = 'message_agent'
export const START_AGENT_TOOL_NAME = 'start_agent'
export const BROADCAST_TOOL_NAME = 'broadcast'
export const NAVIGATE_UI_TOOL_NAME = 'navigate_ui'
export const RUN_COMMAND_TOOL_NAME = 'run_command'
export const DESCRIBE_SCREEN_TOOL_NAME = 'describe_screen'
export const SEE_SCREEN_TOOL_NAME = 'see_screen'
export const CLICK_ELEMENT_TOOL_NAME = 'click_element'
export const TYPE_INTO_TOOL_NAME = 'type_into'
export const READ_TERMINAL_TOOL_NAME = 'read_terminal'
export const OPEN_URL_TOOL_NAME = 'open_url'

/**
 * A UI action main performs on the session-owner window (CDP synthetic input against the
 * element a see_screen ref points at). Refs are per-snapshot: any navigation or click can
 * invalidate them, and the action result carries a fresh tree so the model never reuses a
 * stale one.
 */
export type VoiceUiAction =
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string }

/** The driver's answer to a UI action: the outcome plus the post-action screen tree. */
export type VoiceUiActionResult =
  | { ok: true; elementName: string; tree: string }
  | { ok: false; error: string }

/** One tab in the screen snapshot — what the user can see, in words. */
export type VoiceScreenTabSnapshot = {
  title: string
  contentType: string
  active: boolean
}

/**
 * The renderer's answer to describe_screen: a compact textual snapshot of the Orca
 * window. Text, not pixels — the realtime model has no vision input in this pipeline,
 * and the tab/worktree truth lives in the renderer's stores anyway.
 */
export type VoiceScreenSnapshot = {
  /** Top-level view (terminal, settings, …). */
  view: string
  /** Display name of the active workspace, when one is selected. */
  worktreeName: string | null
  /** Branch of the active workspace — display names collide (two "main" worktrees),
   *  and the branch is the disambiguator the sidebar shows. Absent on older renderers. */
  worktreeBranch?: string | null
  /** Tabs of the active workspace, visual order, focus marked. */
  tabs: VoiceScreenTabSnapshot[]
  leftSidebarOpen: boolean
  /** Right sidebar tab name when open, null when closed. */
  rightSidebar: string | null
}

/**
 * The closed verb set for navigate_ui. The verbs map to ui:* commands the renderer
 * obeys (the same channels the keyboard shortcuts drive, plus ui:closeSettings mirroring
 * the settings back button) — no new UI behavior, just voice-addressable names for it.
 * `focus-agent` takes the agent param.
 */
export const VOICE_NAVIGATE_VERBS = [
  'focus-agent',
  'open-settings',
  'close-settings',
  'quick-open',
  'worktree-palette',
  'floating-terminal',
  'tasks',
  'agent-dashboard',
  'workspace-board',
  'new-browser-tab',
  'toggle-left-sidebar',
  'toggle-right-sidebar'
] as const
export type VoiceNavigateVerb = (typeof VOICE_NAVIGATE_VERBS)[number]

/**
 * One line of the voice session transcript — the durable JSONL log (main) and the live
 * transcript panel (renderer) share this shape over the voice-control:transcriptEntry
 * channel and the getTranscript read.
 */
export type VoiceTranscriptEntry =
  | { ts: number; kind: 'user' | 'assistant'; text: string }
  | { ts: number; kind: 'command'; command: string; cwd: string; output: string }
  | { ts: number; kind: 'update'; spokenName: string; text: string }
  | { ts: number; kind: 'ui'; summary: string }

export type VoiceControlStartResult =
  | { ok: true; sessionId: string }
  | { ok: false; errorKind: VoiceControlErrorKind; error: string }

export type VoiceControlExchangeSdpResult =
  | { ok: true; answerSdp: string }
  | { ok: false; errorKind: VoiceControlErrorKind; error: string }
