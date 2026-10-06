import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-background-task-wire'
import type { AgentSessionRewindReason, AgentSessionRewindSupport } from './agent-session-rewind'
import type { AgentSessionWireRefusal } from './agent-session-wire-refusals'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from './agent-session-queued-message-wire'

export * from './agent-session-wire-refusals'
export * from './agent-session-queued-message-wire'
export * from './agent-session-turn-completion-wire'
import type { AgentSessionConversationCommand } from './agent-session-conversation-command'
import type { AgentSessionContextUsage } from './agent-session-context-usage'
// ─── Structured agent-session wire contract ─────────────────────────────────
// The shapes `agentSession.*` accepts and publishes. Phase 2 builds provider
// adapters and clients against exactly these types, so everything here must be
// plain JSON. The whole surface is gated by agent-session.structured.v1, which
// no released baseline advertises; after that capability ships, every new field
// must remain optional to old readers (docs/reference/remote-wire-compatibility.md).

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalResetReason,
  AgentJournalResolution,
  AgentJournalSubmission,
  AgentJournalThreadGoal,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import type { AgentSessionHandoffStage, AgentSessionRecord } from './agent-session-record'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { NativeChatSubagentEntry } from './native-chat-types'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

/** `agentSession.handoffStatus`. Named for the removed terminal handoff; released desktop clients
 *  still read `owner`. Clients parse the reply as unknown, since older hosts sent more fields. */
export type AgentSessionHandoffStatus = {
  owner: 'native' | 'none'
  direction: 'to-native' | null
  phase: 'idle' | 'switching' | 'failed'
  stage: AgentSessionHandoffStage | null
  operationId: string | null
  error?: { message: string; recoverableOwner: 'none' }
}

export type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState,
  AgentSessionBackgroundTaskState
} from './agent-session-background-task-wire'
export { agentSessionBackgroundTasksEqual } from './agent-session-background-task-wire'

export type AgentSessionTurnActivity = {
  turnId: string
  text: string
}

/** The session's newest turn record over the WHOLE journal. A page windows the timeline and a
 *  turn's record keeps the place it opened at, so a long turn's record falls off the page; this is
 *  what tells a client a turn is running. Present null: the journal records no turn. Absent: an
 *  older host, whose clients still read the loaded rows. */
export type AgentSessionLatestTurn = {
  /** The record's journal key, which rows of the turn name as their scope. */
  itemId: string
  /** Host clock at the record's creation, as on its own row; a revision does not move it. */
  observedAt: number
  turn: AgentJournalTurnLifecycle
}

export const AGENT_SESSION_ID_MAX_LENGTH = 512

/** Backward paging is the client's normal read; 40 matches the page size the
 *  mobile list renders without a visible fill-in. */
export const AGENT_SESSION_HISTORY_DEFAULT_LIMIT = 40
export const AGENT_SESSION_HISTORY_MAX_LIMIT = 200

export const AGENT_SESSION_HISTORY_DIRECTIONS = ['tail', 'before', 'after'] as const
/** `tail` is the newest page, `before` pages backward, `after` catches a live
 *  reader up. Only `after` needs replayable rows; the other two read the
 *  reduced timeline and so survive compaction. */
export type AgentSessionHistoryDirection = (typeof AGENT_SESSION_HISTORY_DIRECTIONS)[number]

export type AgentSessionHistoryRequest = {
  sessionId: string
  direction: AgentSessionHistoryDirection
  /** Required for `before` and `after`; ignored for `tail`. */
  cursor?: AgentJournalCursor
  limit?: number
}

/** A subagent named by a roster row the page does not carry, while its own rows are on it. */
export type AgentSessionSubagentRosterEntry = {
  /** The roster row naming it: the first that does. */
  itemId: string
  sequence: number
  sequenceIndex?: number
  revision: number
  entry: NativeChatSubagentEntry
}

export type AgentSessionHistoryPage = {
  sessionId: string
  epoch: string
  /** Optional for mixed-version readers; write-capable clients use the
   *  checkpoint without forcing a second attach or a redundant snapshot. */
  fence?: number
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  /** Populated by `after` reads so a disconnected client can apply tombstones. */
  removedItemIds: string[]
  /** Submissions overlapping this page, so an unconfirmed bubble renders with
   *  its dispatch state instead of as a plain message. */
  submissions: AgentJournalSubmission[]
  /** Page edges. `nextCursor` is what the client sends back for the same
   *  direction; it equals the request cursor when the page is empty. */
  window: {
    oldest: AgentJournalCursor | null
    newest: AgentJournalCursor | null
    nextCursor: AgentJournalCursor
  }
  /** Current journal head for switching from a bounded page to live subscribe. */
  liveCursor?: AgentJournalCursor
  hasOlder: boolean
  hasNewer: boolean
  /** Present on hosts that expose provider-owned background task lifecycle. */
  backgroundTasks?: AgentSessionBackgroundTaskState | null
  /** The host's queued drafts. Absent = no claim (older host); `[]`/null = empty.
   *  Live subscription state stays authoritative over a stale history answer. */
  queuedMessages?: AgentSessionQueuedMessage[] | null
  /** The queue's pause, published with the list: present whenever `queuedMessages` is, null
   *  when the queue sends on its own. */
  queuePause?: AgentSessionQueuePause | null
  /** Host wall clock (ms epoch) when the page was read, so a client attaching mid-turn
   *  can anchor a live counter on the real start. Absent from older hosts. */
  hostNow?: number
  /** Names the subagents with rows on the page whose roster row is older than it; bounded.
   *  Absent from older hosts, and when every such roster row is on the page. */
  subagentRoster?: AgentSessionSubagentRosterEntry[]
  /** As of the page's read; a client applies it only from a page that replaces its state. */
  latestTurn?: AgentSessionLatestTurn | null
}

export type AgentSessionHistoryResult =
  | { ok: true; page: AgentSessionHistoryPage; providerSession?: AgentProviderSessionMetadata }
  /** Every reset carries a byte-bounded tail page so recovery cannot exceed
   *  remote outbound admission or require another call before resubscribing. */
  | {
      ok: false
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence?: number
      providerSession?: AgentProviderSessionMetadata
    }

/** Cursor-qualified incremental publication. Items and submissions carry their
 *  CURRENT reduced state rather than a delta, so applying a batch twice
 *  converges instead of double-appending. */
export type AgentSessionJournalBatch = {
  cursor: AgentJournalCursor
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  submissions: AgentJournalSubmission[]
}

/** Host wall clock (ms epoch) stamped once per published frame; see `AgentSessionHistoryPage`. */
type AgentSessionHostClockField = { hostNow?: number }

export type AgentSessionSubscribeEvent =
  | ({
      type: 'snapshot'
      sessionId: string
      page: AgentSessionHistoryPage
      fence: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Whole-list draft publication; omitted when unchanged since the last frame sent. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Rides with `queuedMessages`; null when the queue sends on its own. */
      queuePause?: AgentSessionQueuePause | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      /** Latest provider-authored turn activity; optional for mixed-version hosts. */
      activity?: AgentSessionTurnActivity | null
    } & AgentSessionHostClockField)
  | ({
      type: 'batch'
      sessionId: string
      batch: AgentSessionJournalBatch
      /** Optional so mixed-version cursors retain the ownership fence. */
      fence?: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Whole-list draft publication. On a multi-page catch-up it rides only the
       *  final page, so a consumed card never vanishes before its bubble arrives. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Rides with `queuedMessages`; null when the queue sends on its own. */
      queuePause?: AgentSessionQueuePause | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      /** Additive ephemeral state; it never creates or advances journal rows. */
      activity?: AgentSessionTurnActivity | null
      /** Rides every batch that carries rows, removals or submissions, so absent there means an
       *  older host; absent on one that carries none, which changes no turn. */
      latestTurn?: AgentSessionLatestTurn | null
    } & AgentSessionHostClockField)
  | ({
      type: 'reset'
      sessionId: string
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Whole-list draft publication; a reset re-hydrates it with the page. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Rides with `queuedMessages`; null when the queue sends on its own. */
      queuePause?: AgentSessionQueuePause | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      activity?: AgentSessionTurnActivity | null
    } & AgentSessionHostClockField)
  | { type: 'end' }

// ─── Status feed ────────────────────────────────────────────────────────────

/** What a session list needs to know about one session. The host projects it
 *  from the journal so no client has to replay a transcript to learn whether a
 *  turn is running. Additive surface: an older host has no such method. */
export type AgentSessionStatusSummary = {
  rewindBlockedReason?: AgentSessionRewindReason
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  /** Null until the journal holds a persisted user or assistant message. */
  status: StructuredAgentSessionProjectedStatus | null
  /** Present only while this host has the provider child executing the session. */
  hostExecutionOwned?: true
  /** With `hostExecutionOwned`: whether that child has proven its start. `starting` is a
   *  published session whose provider has not yet answered startup; absent on older hosts. */
  hostExecutionPhase?: 'starting' | 'ready'
  latestPrompt: string
  /** Provider model in force for the next turn; absent until the host has read the options. */
  model?: string
  /** The tool the running turn is inside, else the last one it used. Absent unless `status`
   *  is 'working'. */
  toolName?: string
  toolInput?: string
  /** Preview of the newest assistant prose, so a settled row says what the agent said. */
  lastAssistantMessage?: string
  /** The verdict on the latest request: the provider's, or, when it gave none, what the host
   *  observed of the turn's end. Present only while `status` is `idle`: a running or
   *  attention-blocked turn has no verdict yet, and a stale one must not ride along. Absent means
   *  UNKNOWN, never success. Optional for mixed-version hosts; an older client reads an arm it
   *  does not know as no verdict. The agent-status row publishes it as `mainAgent.outcome`. */
  turnOutcome?: AgentTurnOutcome
  /** Present only while `status` is 'working' and a person's Stop is still ending that work: while
   *  the Stop settles, then until the turn it stopped or failed to stop ends. A Stop that settles
   *  having stopped nothing clears it. Derived by the host, never stored. Absent from older hosts;
   *  an older client ignores it. */
  stopping?: true
  /** Live provider-owned background tasks, so session lists can render
   *  subagent children without holding a journal reader open. Optional for
   *  mixed-version hosts. Derived from `children` on hosts that publish it. */
  backgroundTasks?: AgentSessionBackgroundTask[]
  /** The host's running child records for this session, as views: live ones, and a finished one
   *  whose own work still runs (it reads monitoring); finished children ride the background-task
   *  channel only. Absent from older hosts; decode with `decodeAgentChildWorkViews`. Usage is
   *  omitted, and an evidence clock that only ticked does not republish: per-tick freshness rides
   *  the background-task channel. */
  children?: AgentChildWorkView[]
  providerSession?: AgentProviderSessionMetadata
  /** Host-path directory the session is held to regardless of its workspace's current directory
   *  (a floating chat's pinned folder). Absent means resolve the workspace id; older hosts omit it. */
  launchDirectory?: string
  updatedAt: number
  /** When the session's own agent entered `status`, dated by its own lifecycle edges and never by
   *  row activity: `updatedAt` also moves for a subagent's rows. Absent from older hosts, and when
   *  the journal records no such edge; readers then keep dating the state themselves. */
  statusStartedAt?: number
}

/** A summary outlives its provider child: an evicted idle session is still idle, so the host
 *  keeps the last projection and never retracts one. Tabs, not this feed, decide what is listed. */
export type AgentSessionStatusEvent =
  | { type: 'snapshot'; sessions: AgentSessionStatusSummary[] }
  | { type: 'status'; session: AgentSessionStatusSummary }
  | { type: 'end' }

// ─── Mutation envelope ──────────────────────────────────────────────────────

/**
 * The four fields every mutating call carries. Same operation id and same
 * fingerprint replays the recorded outcome; a different fingerprint under one
 * operation id is a conflict, never a second effect.
 */
export type AgentSessionMutationEnvelope = {
  sessionId: string
  clientOperationId: string
  /** Null only on a create for a session that does not exist yet. */
  expectedRuntimeFence: number | null
  /** Client-declared; the host recomputes it and compares. */
  payloadFingerprint: string
}

export type AgentSessionMutationResult<TValue> =
  | {
      ok: true
      /** True when the recorded outcome was returned instead of a new effect. */
      replayed: boolean
      fence: number
      cursor: AgentJournalCursor
      value: TValue
    }
  | { ok: false; refusal: AgentSessionWireRefusal }

// ─── Per-method payloads ────────────────────────────────────────────────────

export type AgentSessionAttachResult = {
  sessionId: string
  fence: number
  page: AgentSessionHistoryPage
  /** Submissions a crash boundary left `unknown` that provider history could not decide. */
  unconfirmedClientMessageIds: string[]
  /** The host-owned id of the tab showing this chat, when it has one. Absent from older hosts. */
  tabId?: string
}

/** The host queued the send as a draft instead of submitting it. Only clients
 *  that sent `delivery: 'queue-if-active'` — gated on
 *  `agent-session.queued-messages.v1` — ever receive this arm; `state` other
 *  than `waiting` appears only on replays of an already-settled draft. */
export type AgentSessionQueuedSendReceipt = {
  messageId: string
  position: number
  state: 'waiting' | 'dispatched' | 'returned' | 'withdrawn'
}

export type AgentSessionSendResult =
  | {
      clientMessageId: string
      submission: AgentJournalSubmission
    }
  | { clientMessageId: string; queued: AgentSessionQueuedSendReceipt }

/** The submission arm's payload; undefined for a queued answer. For callers that
 *  never send `delivery` the queued arm cannot arrive, and `undefined` reads as
 *  delivery-unknown rather than as an error. */
export function agentSessionSendSubmission(
  result: AgentSessionSendResult | undefined
): AgentJournalSubmission | undefined {
  return result !== undefined && 'submission' in result ? result.submission : undefined
}

export type AgentSessionCancelResult = {
  /** The turn the client named, echoed so a late reply can be matched; absent when it named none. */
  turnId?: string
  cancelled: boolean
}

export type AgentSessionPromptResult = {
  itemId: string
  revision: number
  resolution: AgentJournalResolution
}

export type AgentSessionOptionResult = {
  key: string
  value: string
  /** Full effective next-turn values when the provider reconciled related options. */
  options?: Record<string, string>
}

export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

export type AgentSessionModelOption = {
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  efforts: AgentSessionOptionChoice[]
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
}

export type AgentSessionFastModeState = 'off' | 'cooldown' | 'on'

export type AgentSessionFastModeSupport = {
  supported: boolean
  /** Provider-authored or host-normalized reason code; presentation may ignore unknown values. */
  reason?: string
}

/**
 * The host's model catalog for an agent, answered from its own store and
 * never through a session's queue. `unknown` means this host has no listing
 * for the key yet — the client keeps its static seed. Additive read-only
 * surface: an older host simply lacks the method.
 */
export type AgentSessionModelCatalogResult =
  | {
      origin: 'unknown'
      /** The host is running its first listing for this account; a `waitForListing` read answers
       *  when it lands. Absent from a host that predates it. */
      listingInProgress?: true
    }
  | {
      /** What produced the listing; any age is served, `fetchedAt` carries it. */
      origin: 'live-session' | 'probe'
      models: AgentSessionModelOption[]
      fastModeSupport?: AgentSessionFastModeSupport
      fetchedAt: number
    }

/** One entry of the `/` menu the running provider reports for itself. `skill`
 *  marks a name the session loaded as a skill rather than a built-in command;
 *  commands the provider reserves for a terminal UI are already removed. */
export type AgentSessionSlashCommand = {
  name: string
  kind: 'command' | 'skill'
  /** Membership is authoritative, but this provider report did not classify the name. */
  kindUnspecified?: true
  /** Provider-authored row text; absent when the report carried names only. */
  description?: string
  /** Provider-authored argument sketch, e.g. `<issue-url>`. */
  argumentHint?: string
}

/** The provider's own command surface, read per session. Additive read-only
 *  surface: a host that predates it answers `method_not_found`, and the client
 *  keeps rendering its curated catalog. */
export type AgentSessionCommandsResult = {
  commands?: AgentSessionSlashCommand[]
}

/** Longest objective a client may send; matches the provider's own limit. */
export const AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH = 4000

/** A client's change to the thread goal. `set` replaces the objective and makes
 *  it active, which the provider pursues without a separate turn. */
export type AgentSessionThreadGoalChange =
  | { kind: 'set'; objective: string }
  | { kind: 'status'; status: 'active' | 'paused' }
  | { kind: 'clear' }

export type AgentSessionThreadGoalResult = {
  change: AgentSessionThreadGoalChange['kind']
}

/** Provider-reported choices and effective next-turn values. Additive read-only
 *  surface so older hosts can reject it without changing structured v1 writes. */
export type AgentSessionOptionsResult = {
  rewind?: AgentSessionRewindSupport
  conversationCommands?: readonly AgentSessionConversationCommand[]
  /** Present only where this session can change its goal, so a host without
   *  `agentSession.threadGoal` never offers the controls. `current` is the
   *  latest goal the whole journal records, for a client whose loaded page
   *  starts after it. */
  threadGoal?: { current: AgentJournalThreadGoal | null }
  /** Present only where this session writes context facts to its turn rows.
   *  `current` is the newest of each part the whole journal records, for a
   *  client whose loaded page starts after the row that carries it. */
  contextUsage?: { current: AgentSessionContextUsage }
  models: AgentSessionModelOption[]
  /** Session/account/transport support. Absent means unknown, never unsupported. */
  fastModeSupport?: AgentSessionFastModeSupport
  current: {
    model: string
    effort?: string
    /** Canonical preference for the next turn. Explicit false is meaningful. */
    fastMode?: boolean
    /** Provider-reported effective routing, distinct from the next-turn preference. */
    fastModeState?: AgentSessionFastModeState
    /**
     * Option ids whose value the provider reported back, not merely accepted.
     * Optional: a host that predates it sends nothing and the client keeps
     * treating the value as unconfirmed, which is what it was before.
     */
    confirmed?: readonly string[]
  }
}
