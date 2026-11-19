// The agent-session map: a session journal projected into a node graph (main agent,
// sub-agents, tool calls) plus an event timeline the scrubber plays over. Pure and
// isomorphic — desktop, web and mobile build the same map from the same journal.

export type AgentMapNodeId = string

/** 'root' is the session's own agent; every other id is a subagent's canonical id. */
export const AGENT_MAP_ROOT_ID: AgentMapNodeId = 'root'

export const AGENT_MAP_NODE_KINDS = ['main', 'subagent'] as const
export type AgentMapNodeKind = (typeof AGENT_MAP_NODE_KINDS)[number]

/** Ground truth only: a status is claimed from a dated event, never from silence.
 *  `unknown` is a node whose rows carry no activity this build can place. */
export const AGENT_MAP_NODE_STATUSES = [
  'running',
  'waiting',
  'idle',
  'done',
  'failed',
  'unknown'
] as const
export type AgentMapNodeStatus = (typeof AGENT_MAP_NODE_STATUSES)[number]

export const AGENT_MAP_TOOL_CALL_STATES = ['running', 'completed', 'failed'] as const
export type AgentMapToolCallState = (typeof AGENT_MAP_TOOL_CALL_STATES)[number]

export type AgentMapToolCall = {
  /** The journal callId, or the item id when the host predates callIds. */
  callId: string
  name: string
  /** One-line rendering of the input; '' when the tool has no readable input. */
  summary: string
  state: AgentMapToolCallState
  startTs: number
  endTs?: number
  durationMs?: number
}

export const AGENT_MAP_TURN_STATES = [
  'running',
  'completed',
  'interrupted',
  'unverifiable'
] as const
export type AgentMapTurnState = (typeof AGENT_MAP_TURN_STATES)[number]

export type AgentMapTurn = {
  turnId: string
  state: AgentMapTurnState
  startedAt?: number
  endedAt?: number
  durationMs?: number
}

export const AGENT_MAP_REQUEST_KINDS = ['question', 'approval'] as const
export type AgentMapRequestKind = (typeof AGENT_MAP_REQUEST_KINDS)[number]

export const AGENT_MAP_REQUEST_RESOLUTIONS = ['pending', 'resolved', 'cancelled'] as const
export type AgentMapRequestResolution = (typeof AGENT_MAP_REQUEST_RESOLUTIONS)[number]

/** A question or approval the node raised: pending until its resolution dates. */
export type AgentMapRequest = {
  kind: AgentMapRequestKind
  ts: number
  resolution: AgentMapRequestResolution
  resolvedAt?: number
  /** The question text or the approval title, when the row carried one. */
  detail?: string
}

/** The provider's own verdict on a child agent, from the spawn roster. Absent when the
 *  provider never reported one — silence is not a verdict. */
export type AgentMapSubagentSettlement = {
  state: 'working' | 'idle' | 'completed' | 'failed' | 'stopped' | 'unverifiable'
  settledAt?: number
}

export type AgentMapNode = {
  id: AgentMapNodeId
  kind: AgentMapNodeKind
  /** Display name: the subagent's type or label when known, else a short id. */
  label: string
  parentAgentId?: AgentMapNodeId
  firstTs: number
  lastTs: number
  /** In startTs order. */
  toolCalls: AgentMapToolCall[]
  turns: AgentMapTurn[]
  requests: AgentMapRequest[]
  promptCount: number
  /** Diff paths this node touched, unique, first-seen order. */
  filesTouched: string[]
  /** The node's newest user prompt text, when it received one. */
  lastPromptText?: string
  /** When that prompt's row was observed. */
  lastPromptTs?: number
  subagentSettlement?: AgentMapSubagentSettlement
  /** The node's newest status row text, when it reports one. */
  lastStatusText?: string
}

export type AgentMapEdge = {
  from: AgentMapNodeId
  to: AgentMapNodeId
  spawnedAt: number
}

export const AGENT_MAP_TIMELINE_EVENT_KINDS = [
  'prompt',
  'tool-start',
  'tool-end',
  'agent-spawn',
  'turn-end',
  'question',
  'approval'
] as const
export type AgentMapTimelineEventKind = (typeof AGENT_MAP_TIMELINE_EVENT_KINDS)[number]

export type AgentMapTimelineEvent = {
  ts: number
  /** Journal sequence of the producing row; breaks ties when timestamps collide. */
  seq: number
  kind: AgentMapTimelineEventKind
  nodeId: AgentMapNodeId
  detail: string
  /** On tool-end / turn-end: the end was a failure. */
  failed?: boolean
}

export type AgentMap = {
  rootId: typeof AGENT_MAP_ROOT_ID
  /** Root first, then spawn order. */
  nodes: AgentMapNode[]
  edges: AgentMapEdge[]
  /** ts-ordered (seq as tiebreak); the scrubber indexes it. */
  timeline: AgentMapTimelineEvent[]
}

/** Session-level facts for the map's info strip: what the whole run did, not one node. */
export type AgentMapSessionSummary = {
  agentCount: number
  toolCallCount: number
  /** Every path any node touched, unique, first-seen order. */
  filesTouched: string[]
  /** The newest user prompt anywhere in the session. */
  lastPromptText?: string
}

// ─── Playhead ───────────────────────────────────────────────────────────────

/** The map as of one moment: which nodes exist, their status, what is active.
 *  `ts: null` is the live edge (the newest event). A pure function of (map, ts). */
export type AgentMapNodeViewState = {
  nodeId: AgentMapNodeId
  status: AgentMapNodeStatus
  /** The tool running at `ts`, if any. */
  activeTool?: AgentMapToolCall
  toolCount: number
  completedToolCount: number
  failedToolCount: number
  promptCount: number
  waitingOn?: AgentMapRequestKind
  lastStatusText?: string
}

export type AgentMapViewState = {
  /** The resolved playhead: the newest event ts when live. */
  ts: number
  nodes: AgentMapNodeViewState[]
  /** Nodes running or waiting at `ts`, in spawn order. */
  activeNodeIds: AgentMapNodeId[]
}
