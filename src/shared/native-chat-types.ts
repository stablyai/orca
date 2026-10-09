import type { AgentSessionProviderContextBoundary } from './agent-session-provider-context'
// ─── Native chat conversation model (cross-process, IPC-serializable) ────────
// The single renderer-facing conversation contract for the native chat view.
// Assembled from layered sources in priority order: on-disk JSONL transcripts,
// live agent-hook events, and (as a degraded fallback) scrollback scrape — see
// docs/plans/2026-06-17-001-feat-native-chat-view-plan.md (KTD2). Everything
// here must be plain JSON: these values cross the IPC boundary, so no class
// instances, Maps, or Dates.

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
import type { NativeChatToolMetadata } from './native-chat-tool-identity'
import type { AgentMessageSource } from './agent-session-message-source'

export type { AgentType }

/** Where a message came from. Used for dedup precedence: a transcript message
 *  supersedes a hook message, which supersedes a scrape message. */
export const NATIVE_CHAT_SOURCES = ['transcript', 'hook', 'scrape'] as const
export type NativeChatSource = (typeof NATIVE_CHAT_SOURCES)[number]

/** Priority rank for a source — higher wins when two sources describe the same
 *  turn. Kept as data so the assembler's precedence is a single lookup, not a
 *  chain of conditionals. */
export const NATIVE_CHAT_SOURCE_PRIORITY: Record<NativeChatSource, number> = {
  transcript: 3,
  hook: 2,
  scrape: 1
}

export const NATIVE_CHAT_ROLES = ['user', 'assistant', 'tool', 'reasoning', 'system'] as const
export type NativeChatRole = (typeof NATIVE_CHAT_ROLES)[number]

/** Plain prose / markdown. The assistant body, a user prompt, reasoning text. */
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
}

/** A tool invocation by the agent. `input` is the (already-serialized) tool
 *  argument payload; kept as `unknown` because each tool's shape differs and
 *  the renderer only previews it. */
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

/** Hunks the provider resolved against the real file before reporting the edit.
 *  Claude supplies these on its edit results; Codex resolves equivalently before
 *  sending, so its patch already carries ranges and needs no companion. */
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
}

/** A reference to an image, by local path or remote URL. Exactly the field
 *  that applies is populated; `alt` is optional descriptive text. */
export type NativeChatImageRefBlock = {
  type: 'image-ref'
  path?: string
  url?: string
  alt?: string
}

/** Lifecycle of one spawned child agent, as the display collapses it.
 *  `unverifiable` is the repo's loss-of-contact verdict (see
 *  docs/reference/ssh-execution-boundary.md): the child stopped reporting and
 *  nothing proves it exited. Every in-flight provider state collapses to
 *  `working`; `idle` is a child that exists but is not currently working. */
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

/** One spawn group's roster, revised in place as its children report activity.
 *  Provider-agnostic on purpose: the Codex and Claude lanes both feed this. */
export type NativeChatSubagentGroupBlock = {
  type: 'subagent-group'
  /** Stable group key — the parent turn that spawned these children. */
  groupId: string
  agents: NativeChatSubagentEntry[]
}

/** One provider background task — a shell command, workflow or monitor run
 *  beside the turn — as its own durable row, revised in place from the
 *  provider's lifecycle frames. Sibling of the roster block rather than a
 *  one-child roster: a backgrounded `sleep 20` is not a subagent, and a group
 *  holding it would read "Ran 1 subagent".
 *
 *  Outcome is a STATUS FIELD, never a red row: a task that failed is a task
 *  with a terminal state, and the row that reports it is the same row that
 *  reported it starting. */
export type NativeChatBackgroundTaskBlock = {
  type: 'background-task'
  /** Provider task id — the row key, stable across a resume. */
  taskId: string
  kind: AgentSessionBackgroundTask['kind']
  /** Display name: the provider's description, else the identity it reported. */
  label: string
  /** Run state, in the vocabulary the background-tasks strip already renders. */
  state: AgentSessionBackgroundTaskRunState
  /** The tool call that spawned this task. The transcript has no structural
   *  parent link for a row, so the relationship is carried as a field here and
   *  consumers co-locate the row with that tool call. */
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
  | NativeChatBackgroundTaskBlock

/** A transcript row. Structured rows carry the journal row's producer linkage, so
 *  "who said this" survives the projection; terminal-backed rows carry none. */
export type NativeChatMessage = AgentJournalProducerLinkage & {
  /** Stable across re-reads/appends so the assembler and the renderer list can
   *  dedup and key by it. */
  id: string
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Epoch ms when the message was produced, or null when the source could not
   *  supply one (e.g. some scrape segments). Null sorts before any timestamp. */
  timestamp: number | null
  source: NativeChatSource
  /** Optional provider row cursor; split projections share it for whole-row paging. */
  transcriptOffset?: number
  /** Model id that produced an assistant response, as the provider API names it. */
  model?: string
  /** The agent's provider that served `model`, where the agent records one. */
  provider?: string
  /** On assistant responses whose accounting reflects the prompt the model read. */
  usage?: AgentSessionTokenUsage
  /** Optional explicit turn key. When present, two messages with the same
   *  `turnId` are treated as the same turn for dedup regardless of `id`. */
  turnId?: string
  /** `id` of the transcript row this one follows in the agent's own conversation
   *  tree, where the decoder carries the agent's link. Absent from older hosts. */
  parentId?: string
  /** How a user message was delivered when it was not an ordinary prompt. */
  sentAs?: AgentJournalMessageSendMode
  /** The journal row's own lifecycle; absent means unknown, never live. */
  state?: AgentJournalMessageState
  /** Host clock when the row's message was seen to end; absent when no end was seen live. */
  completedAt?: number
  /** On a conversation command the user sent, such as `/compact`: the command it names. */
  command?: { name: string }
  /** On a user-role message another agent sent through Orca: who, as the journal recorded it. */
  from?: AgentMessageSource
  /** Accepted but not yet handed to the agent: drawn after everything the agent has done. */
  queued?: true
  /** Shown as not sent: in no turn, so a newer turn's bar and clock never land on it. Drawn where
   *  the journal recorded it, or after the conversation when it holds no place there. */
  unsent?: true
  /** This client's send, made while the chat read Stopping, that the host has not recorded yet. */
  sentWhileStopping?: true
  /** This client's send the host has not recorded, which only the user's Retry sends again: the
   *  host holds nothing for it, so it never waits behind a turn. */
  awaitsRetry?: true
  /** A send a Stop took back (its submission withdrawn): no rail tick, as the conversation
   *  outline the host serves leaves it out. */
  stoppedBeforeStart?: true
  /** Set only by the structured projection, on rows the journal holds, and ranks
   *  them ahead of time. Terminal-backed messages never carry it, and worker reads strip it. */
  journalPosition?: AgentJournalPosition
  /** Set only by the tool fold, on a row that absorbed later tool rows: the newest
   *  absorbed row's journal position. The row still sorts by its own. */
  foldedJournalPosition?: AgentJournalPosition
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

/** A provider-authored turn boundary recovered from the transcript itself.
 *  Unlike assistant prose, this is explicit lifecycle evidence (completion or
 *  interruption records) and is safe to replay. */
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
  /** Provider-owned conversation id once known; null before the agent reports
   *  one (the view shows live hook state and backfills later). */
  sessionId: string | null
  agent: AgentType
  /** Human-readable error when `status === 'error'`. */
  error?: string
}

// ─── Block type guards ──────────────────────────────────────────────────────
// Narrowing helpers so consumers don't repeat `block.type === '…'` string
// literals. Exported for use by the assembler, renderer, and tests.

export function isTextBlock(block: NativeChatBlock): block is NativeChatTextBlock {
  return block.type === 'text'
}

export function isToolCallBlock(block: NativeChatBlock): block is NativeChatToolCallBlock {
  return block.type === 'tool-call'
}

export function isToolResultBlock(block: NativeChatBlock): block is NativeChatToolResultBlock {
  return block.type === 'tool-result'
}

/** The provider-authored interrupt row the transcript decoders emit (Claude's
 *  `interruptedMessageId` record, Codex's `turn_aborted`). The turn it ends
 *  never delivers results for the tool calls it left in flight. */
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

export function isBackgroundTaskBlock(
  block: NativeChatBlock
): block is NativeChatBackgroundTaskBlock {
  return block.type === 'background-task'
}
