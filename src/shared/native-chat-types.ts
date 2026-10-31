import type { AgentSessionProviderContextBoundary } from './agent-session-provider-context'
// IPC-serializable conversation contract: plain JSON only, no classes/Maps/Dates. Sources prefer transcripts, then hooks,
// then degraded scrollback; docs/plans/2026-06-17-001-feat-native-chat-view-plan.md (KTD2).

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from './agent-session-background-task-wire'
import type { AgentSessionTokenUsage } from './agent-session-context-usage'
import type { AgentSessionOrcaStop } from './agent-session-orca-stop'
import type { AgentSessionFailureFact } from './agent-session-failure'
import type {
  AgentJournalMessageSendMode,
  AgentJournalMessageState,
  AgentJournalPosition,
  AgentJournalProducerLinkage,
  AgentJournalToolCallEnding,
  AgentJournalToolCallState
} from './agent-session-journal-types'
import type { AgentType } from './agent-status-types'
import type { NativeChatToolMetadata } from './native-chat/tools/native-chat-tool-identity'
import type { AgentMessageSource } from './agent-session/agent-session-message-source'

export type { AgentType }

export const NATIVE_CHAT_SOURCES = ['transcript', 'hook', 'scrape'] as const
export type NativeChatSource = (typeof NATIVE_CHAT_SOURCES)[number]

/** Higher source authority wins deduplication of the same turn. */
export const NATIVE_CHAT_SOURCE_PRIORITY: Record<NativeChatSource, number> = {
  transcript: 3,
  hook: 2,
  scrape: 1
}

export const NATIVE_CHAT_ROLES = ['user', 'assistant', 'tool', 'reasoning', 'system'] as const
export type NativeChatRole = (typeof NATIVE_CHAT_ROLES)[number]

export type NativeChatTextBlock = {
  type: 'text'
  text: string
  /** Optional journal display hints; readers narrow only the values they know. */
  presentation?: string
  contextClear?: AgentSessionProviderContextBoundary
  tone?: string
  /** Optional structured detail for an otherwise ordinary fallback line. */
  providerFrame?: {
    provider: string
    kind: string
    payload: {
      head: string
      byteLength: number
      digest: string
      truncated: boolean
    }
  }
  /** On a status line that reports a failure: what failed, typed. */
  failure?: AgentSessionFailureFact
  /** On the line about a reply Orca's own stop cut off: why, and the turn it cut. */
  orcaStop?: AgentSessionOrcaStop & { turnItemId?: string }
  /** On a usage-limit line: the turn the limit ended, which its Continue picks up. */
  usageLimitTurnItemId?: string
}

/** Tool arguments remain unknown because provider shapes differ; renderers preview the serialized payload. */
export type NativeChatToolCallBlock = NativeChatToolMetadata & {
  type: 'tool-call'
  name: string
  input: unknown
  /** Provider-supplied identity within this item stream; absent on legacy transcripts and peers. */
  callId?: string
  /** Provider lifecycle when the structured app-server path can supply it. */
  state?: AgentJournalToolCallState
  /** See the journal tool-call item: read with `state` through `agentJournalToolCallLifecycle`. */
  endedAs?: AgentJournalToolCallEnding
}

/** One resolved hunk from a provider's edit result, carrying true file ranges. */
export type NativeChatEditPatchHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Signed unified rows, as the provider emitted them. */
  lines: string[]
}

/** Provider-resolved file hunks: Claude attaches them to results; Codex resolves ranges in its patch before sending. */
export type NativeChatEditPatch = {
  filePath?: string
  hunks: NativeChatEditPatchHunk[]
}

/** The result returned to the agent for a prior tool call. */
export type NativeChatToolResultBlock = {
  type: 'tool-result'
  output: string
  isError?: boolean
  /** The call this result answers, when the producer knows it; otherwise pairing is positional. */
  callId?: string
  /** Present only for edit tools whose result reported resolved hunks. */
  editPatch?: NativeChatEditPatch
  /** The journal item to fetch when `output` is only a head of what the tool returned. */
  fullOutputItemId?: string
}

/** Local path or remote URL, exactly one populated; optional alt text. */
export type NativeChatImageRefBlock = {
  type: 'image-ref'
  path?: string
  url?: string
  alt?: string
}

/** Collapse in-flight provider states to working. idle means existing but inactive; unverifiable means contact lost without proof of exit
 * (docs/reference/ssh-execution-boundary.md). */
export const NATIVE_CHAT_SUBAGENT_STATES = [
  'working',
  'idle',
  'completed',
  'failed',
  'stopped',
  'unverifiable'
] as const
export type NativeChatSubagentState = (typeof NATIVE_CHAT_SUBAGENT_STATES)[number]

/** One child agent in a spawn group. */
export type NativeChatSubagentEntry = {
  /** Provider's child id (Codex: the child thread id). The roster key. */
  id: string
  /** Row label — the provider's task name, disambiguated by ordinal on collision. */
  label: string
  state: NativeChatSubagentState
  /** Latest total tokens the provider reported FOR THIS CHILD, never a running sum. */
  tokens?: number
  /** Epoch ms the child's latest run started; a resumed child restarts it. */
  startedAt?: number
  /** Epoch ms the entry latched terminal. */
  settledAt?: number
}

/** Provider-neutral roster revised in place by Claude/Codex activity. */
export type NativeChatSubagentGroupBlock = {
  type: 'subagent-group'
  /** Stable group key — the parent turn that spawned these children. */
  groupId: string
  agents: NativeChatSubagentEntry[]
}

/** Individual subagent row revised at its spawn position. Readers derive sibling groups from groupId/parentId; no row lists them together. */
export type NativeChatSubagentBlock = NativeChatSubagentEntry & {
  type: 'subagent'
  /** The turn that spawned it: siblings with the same key draw together. */
  groupId: string
  /** The subagent that spawned it. Absent ⇒ the session's own agent did. */
  parentId?: string
  /** The provider's id for the run `state` describes. Absent when the provider names none. */
  run?: string
  /** `stop-acknowledged`: stopped because the agent accepted a Stop, not because the child
   *  reported its own end; that run's own ending may still replace it. */
  outcomeBasis?: 'stop-acknowledged'
  /** Told to outlive the turn that spawned it. */
  background?: true
}

/** Durable provider task row, revised in place from lifecycle frames. Shell/workflow/monitor tasks are distinct from subagent rosters.
 * Failures change state on the same row rather than becoming separate red error rows. */
export type NativeChatBackgroundTaskBlock = {
  type: 'background-task'
  /** Provider task id — the row key, stable across a resume. */
  taskId: string
  kind: AgentSessionBackgroundTask['kind']
  /** Display name: the provider's description, else the identity it reported. */
  label: string
  /** Run state, in the vocabulary the background-tasks strip already renders. */
  state: AgentSessionBackgroundTaskRunState
  /** Structural link used to co-locate the task with its spawning call; transcript rows have no separate parent relationship. */
  parentToolUseId?: string
  /** The provider's own sentence about the outcome, when it sent one. */
  summary?: string
  /** The provider's error text, when it reported one apart from the summary. */
  error?: string
  /** Where the provider wrote the task's output. */
  outputFile?: string
  /** Latest total tokens the provider reported FOR THIS TASK. */
  tokens?: number
  startedAt?: number
  /** Epoch ms the row latched terminal. */
  settledAt?: number
}

export type NativeChatBlock =
  | NativeChatTextBlock
  | NativeChatToolCallBlock
  | NativeChatToolResultBlock
  | NativeChatImageRefBlock
  | NativeChatSubagentGroupBlock
  | NativeChatSubagentBlock
  | NativeChatBackgroundTaskBlock

/** Structured rows preserve journal producer linkage; terminal-backed rows omit it. */
export type NativeChatMessage = AgentJournalProducerLinkage & {
  /** Stable dedup/list identity across re-reads and appends. */
  id: string
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Epoch ms; null when unavailable (e.g. scrape). */
  timestamp: number | null
  source: NativeChatSource
  /** Optional provider row cursor; split projections share it for whole-row paging. */
  transcriptOffset?: number
  /** Canonical display position: JSONL record byte start or database provider sequence, independent of clocks/cursors. */
  transcriptOrder?: number
  /** Model id that produced an assistant response, as the provider API names it. */
  model?: string
  /** The agent's provider that served `model`, where the agent records one. */
  provider?: string
  /** On assistant responses whose accounting reflects the prompt the model read. */
  usage?: AgentSessionTokenUsage
  /** Explicit turn key overrides differing ids for turn deduplication. */
  turnId?: string
  /** Provider conversation-tree predecessor id; older hosts omit it. */
  parentId?: string
  /** How a user message was delivered when it was not an ordinary prompt. */
  sentAs?: AgentJournalMessageSendMode
  /** Its text was shortened to fit the copy sent to this client; the host keeps it whole. */
  shortened?: true
  /** The journal row's own lifecycle; absent means unknown, never live. */
  state?: AgentJournalMessageState
  /** Host clock when the row's message was seen to end; absent when no end was seen live. */
  completedAt?: number
  /** On a conversation command the user sent, such as `/compact`: the command it names. */
  command?: { name: string }
  /** On a user-role message another agent sent through Orca: who, as the journal recorded it. */
  from?: AgentMessageSource
  /** Projected creation fact, never a user turn or provider input. */
  agentStart?: true
  /** Accepted but not yet handed to the agent: drawn after everything the agent has done. */
  queued?: true
  /** Unsent rows belong to no turn. Draw at journal position, or after the conversation when unplaced. */
  unsent?: true
  /** This client's send, made while the chat read Stopping, that the host has not recorded yet. */
  sentWhileStopping?: true
  /** Unrecorded client send awaiting explicit Retry; host holds nothing, so it cannot wait behind a turn. */
  awaitsRetry?: true
  /** Withdrawn sends have no rail tick because the host conversation outline excludes them. */
  stoppedBeforeStart?: true
  /** Structured journal ordering outranks timestamps; terminal transcripts omit it and worker reads strip it. */
  journalPosition?: AgentJournalPosition
  /** Newest absorbed tool row’s position; the folded row still sorts by its own position. */
  foldedJournalPosition?: AgentJournalPosition
  /** Private presentation row; raw host messages never publish this fold-only marker. */
  unpairedToolResults?: true
}

/** Split reasoning and its answer share the provider's row identity. */
export function nativeChatSemanticRowId(message: NativeChatMessage): string {
  return message.role === 'reasoning' && message.id.endsWith(':reasoning')
    ? message.id.slice(0, -':reasoning'.length)
    : message.id
}

/** New hosts expose the cursor; older messages retain their reasoning/answer id convention. */
export function nativeChatMessagesShareTranscriptRow(
  first: NativeChatMessage,
  second: NativeChatMessage
): boolean {
  if (typeof first.transcriptOffset === 'number' && typeof second.transcriptOffset === 'number') {
    return first.transcriptOffset === second.transcriptOffset
  }
  return (
    first.role === 'reasoning' &&
    second.role === 'assistant' &&
    nativeChatSemanticRowId(first) === second.id
  )
}

export const NATIVE_CHAT_TURN_LIFECYCLE_STATES = ['working', 'completed', 'interrupted'] as const
export type NativeChatTurnLifecycleState = (typeof NATIVE_CHAT_TURN_LIFECYCLE_STATES)[number]

export const NATIVE_CHAT_INTERRUPTED_STATUS_TEXT = 'Conversation interrupted'

/** Replay-safe provider completion/interruption evidence recovered from transcripts, unlike assistant prose. */
export type NativeChatTurnLifecycle = {
  state: NativeChatTurnLifecycleState
  /** Stable provider id when available, otherwise the JSONL record position. */
  turnId: string
  /** Provider timestamp; null only when the transcript omitted one. */
  timestamp: number | null
}

export const NATIVE_CHAT_SESSION_STATUSES = [
  'loading',
  'ready',
  'working',
  'empty',
  'error'
] as const
export type NativeChatSessionStatus = (typeof NATIVE_CHAT_SESSION_STATUSES)[number]

export type NativeChatSession = {
  messages: NativeChatMessage[]
  status: NativeChatSessionStatus
  /** Provider conversation id; null until reported while the view shows live hooks and later backfills. */
  sessionId: string | null
  agent: AgentType
  /** Human-readable error when `status === 'error'`. */
  error?: string
}

export function isTextBlock(block: NativeChatBlock): block is NativeChatTextBlock {
  return block.type === 'text'
}

export function isToolCallBlock(block: NativeChatBlock): block is NativeChatToolCallBlock {
  return block.type === 'tool-call'
}

export function isToolResultBlock(block: NativeChatBlock): block is NativeChatToolResultBlock {
  return block.type === 'tool-result'
}

/** Provider-authored Claude interruptedMessageId/Codex turn_aborted rows abandon in-flight tool calls without results. */
export function isInterruptedStatusMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && block.text === NATIVE_CHAT_INTERRUPTED_STATUS_TEXT
    )
  )
}

export function isImageRefBlock(block: NativeChatBlock): block is NativeChatImageRefBlock {
  return block.type === 'image-ref'
}

export function isSubagentGroupBlock(
  block: NativeChatBlock
): block is NativeChatSubagentGroupBlock {
  return block.type === 'subagent-group'
}

export function isSubagentBlock(block: NativeChatBlock): block is NativeChatSubagentBlock {
  return block.type === 'subagent'
}

export function isBackgroundTaskBlock(
  block: NativeChatBlock
): block is NativeChatBackgroundTaskBlock {
  return block.type === 'background-task'
}
