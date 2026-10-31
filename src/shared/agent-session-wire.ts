import type { AgentSessionUnavailable } from './agent-session-availability'
import type { AgentSessionFrameFields } from './agent-session-frame-fields'
import type { AgentSessionCurrentWorkFields } from './agent-session-current-work-wire'
import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-background-task-wire'
import type { AgentSessionRewindReason } from './agent-session-rewind'
import type { AgentSessionWireRefusal } from './agent-session-wire-refusals'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from './agent-session-queued-message-wire'

export type { AgentSessionOptionsResult } from './agent-session-options-result'
export * from './agent-session-wire-refusals'
export * from './agent-session-queued-message-wire'
export * from './agent-session-turn-completion-wire'
// Use plain JSON and optional additions after structured.v1; hosts/clients update independently (docs/reference/remote-wire-compatibility.md).

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalResetReason,
  AgentJournalResolution,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from './agent-session-journal-types'
import type { AgentTurnOutcome } from './agent-turn-outcome'
import type { AgentSessionRecord } from './agent-session-record'
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { NativeChatSubagentEntry } from './native-chat-types'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

export type { AgentSessionHandoffStatus } from './agent-session-handoff-status'

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

/** Newest turn across the whole journal, including off-page long-running turns. null means no turn; older hosts omit it and clients derive from loaded rows. */
export type AgentSessionLatestTurn = {
  /** The record's journal key, which rows of the turn name as their scope. */
  itemId: string
  /** Host clock at the record's creation, as on its own row; a revision does not move it. */
  observedAt: number
  turn: AgentJournalTurnLifecycle
}

export const AGENT_SESSION_ID_MAX_LENGTH = 512

/** Use 40 rows to match mobile's rendered page without visible fill-in. */
export const AGENT_SESSION_HISTORY_DEFAULT_LIMIT = 40
export const AGENT_SESSION_HISTORY_MAX_LIMIT = 200

export const AGENT_SESSION_HISTORY_DIRECTIONS = ['tail', 'before', 'after'] as const
/** tail/before read reduced history and survive compaction; after catches up from replayable rows. */
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
  /** Include overlapping submissions so uncertain bubbles retain their dispatch state. */
  submissions: AgentJournalSubmission[]
  /** Return the next same-direction request cursor; keep the request cursor on empty pages. */
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
  /** Publish pause with queuedMessages: null means automatic sending. */
  queuePause?: AgentSessionQueuePause | null
  /** With queuedMessages, name the next unblocked send; null while held or absent on older hosts. */
  nextQueuedMessageId?: string | null
  /** Host wall clock (ms epoch) when the page was read, so a client attaching mid-turn
   *  can anchor a live counter on the real start. Absent from older hosts. */
  hostNow?: number
  /** Names the subagents with rows on the page whose roster row is older than it; bounded.
   *  Absent from older hosts, and when every such roster row is on the page. */
  subagentRoster?: AgentSessionSubagentRosterEntry[]
  /** As of the page's read; a client applies it only from a page that replaces its state. */
  latestTurn?: AgentSessionLatestTurn | null
} & AgentSessionCurrentWorkFields

export type AgentSessionHistoryResult =
  | {
      ok: true
      page: AgentSessionHistoryPage
      providerSession?: AgentProviderSessionMetadata
    }
  /** Every reset carries a byte-bounded tail page so recovery cannot exceed
   *  remote outbound admission or require another call before resubscribing. */
  | {
      ok: false
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence?: number
      providerSession?: AgentProviderSessionMetadata
    }

/** Publish cursor-qualified current reduced states, not deltas, so duplicate batches converge. */
export type AgentSessionJournalBatch = {
  cursor: AgentJournalCursor
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  submissions: AgentJournalSubmission[]
}

export type AgentSessionSubscribeEvent =
  | ({
      type: 'snapshot'
      sessionId: string
      page: AgentSessionHistoryPage
      fence: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Whole-list draft publication; omitted when unchanged since the last frame sent. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      /** Latest provider-authored turn activity; optional for mixed-version hosts. */
      activity?: AgentSessionTurnActivity | null
    } & AgentSessionFrameFields)
  | ({
      type: 'batch'
      sessionId: string
      batch: AgentSessionJournalBatch
      /** Optional so mixed-version cursors retain the ownership fence. */
      fence?: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Publish whole card lists only on the final catch-up page so cards do not vanish before their bubbles arrive. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      /** Additive ephemeral state; it never creates or advances journal rows. */
      activity?: AgentSessionTurnActivity | null
      /** Rides every batch that carries rows, removals or submissions, so absent there means an
       *  older host; absent on one that carries none, which changes no turn. */
      latestTurn?: AgentSessionLatestTurn | null
      /** On a catch-up page with more behind it; absent on the last, live, and from older hosts. */
      hasNewer?: true
    } & AgentSessionCurrentWorkFields &
      AgentSessionFrameFields)
  | ({
      type: 'reset'
      sessionId: string
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence: number
      backgroundTasks?: AgentSessionBackgroundTaskState | null
      /** Whole-list draft publication; a reset re-hydrates it with the page. */
      queuedMessages?: AgentSessionQueuedMessage[] | null
      /** Omitted when unchanged; null clears a previous provider catalog. */
      commands?: AgentSessionSlashCommand[] | null
      activity?: AgentSessionTurnActivity | null
    } & AgentSessionFrameFields)
  | { type: 'end' }

// ─── Status feed ────────────────────────────────────────────────────────────

/** Host-projected list status avoids client transcript replay; older hosts lack this additive method. */
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
  /** This restart action's progress, derived by the live host and never persisted.
   *  Cleared when the action returns; absent on older hosts. */
  restartResume?: {
    phase: 'queued' | 'starting' | 'continued' | 'refused' | 'unconfirmed' | 'skipped'
  }
  latestPrompt: string
  /** Provider model in force for the next turn; absent until the host has read the options. */
  model?: string
  /** The chat's saved permission mode; a client re-reads options when it or `model` moves. */
  permissionMode?: string
  runtimePermission?: { fence: number; mode: string | null } | null
  /** The chat's saved effort, Fast and speed picks, encoded; another device's pick moves them so a
   *  client re-reads options. Absent from older hosts. */
  effort?: string
  fastMode?: string
  serviceTier?: string
  /** The tool the running turn is inside, else the last one it used. Absent unless `status`
   *  is 'working'. */
  toolName?: string
  toolInput?: string
  /** Preview of the newest assistant prose, so a settled row says what the agent said. */
  lastAssistantMessage?: string
  /** Latest request verdict only while idle; never carry it on running/blocked states. Absent or unknown arms mean unknown, never success. Published as mainAgent.outcome in agent status. */
  turnOutcome?: AgentTurnOutcome
  /** Host-derived, unpersisted Stop progress while working until its turn ends; clear a settled no-op Stop. Older hosts omit it and older clients ignore it. */
  stopping?: true
  /** Optional live provider tasks let lists show children without journal subscriptions; derive from children when published. */
  backgroundTasks?: AgentSessionBackgroundTask[]
  /** Running/monitoring child views (decodeAgentChildWorkViews); finished children use background tasks only. Omit usage and per-tick freshness here; the background-task channel carries those ticks. Older hosts omit this. */
  children?: AgentChildWorkView[]
  providerSession?: AgentProviderSessionMetadata
  /** Retain the saved conversation name beyond tab closure; absent while unnamed or on older hosts. */
  conversationName?: string
  /** Why the host could not name this chat, kept in memory only while the chat still has the
   *  name the failed run would have replaced. Absent from older hosts; older clients ignore it. */
  namingError?: AgentSessionNamingError
  /** The record's Sleep mark: the user's Sleep stopped this chat and nothing has been sent since.
   *  Absent from older hosts. */
  sleptAt?: number
  /** Host-path directory the session is held to regardless of its workspace's current directory
   *  (a floating chat's pinned folder). Absent means resolve the workspace id; older hosts omit it. */
  launchDirectory?: string
  updatedAt: number
  /** Date the lead status by its own lifecycle edge, never updatedAt (child rows change it). Missing/older-host dates leave readers tracking time themselves. */
  statusStartedAt?: number
}

/** `failedAt` dates the run, so a repeat failure with the same message still republishes. */
export type AgentSessionNamingError = {
  message: string
  failedAt: number
  /** Names Orca-authored copy; `message` stays English for older clients. */
  messageCode?: string
}

export type AgentSessionConversationName = {
  sessionId: string
  conversationName: string | null
  namingError?: AgentSessionNamingError
}

/** Retain projections after child eviction; idle remains idle. Tabs decide list membership, never this feed. */
export type AgentSessionStatusEvent =
  | {
      type: 'snapshot'
      sessions: AgentSessionStatusSummary[]
      namingActiveSessionIds?: string[]
      conversationNames?: AgentSessionConversationName[]
    }
  | { type: 'status'; session: AgentSessionStatusSummary }
  | { type: 'end' }

// ─── Mutation envelope ──────────────────────────────────────────────────────

/** Same operation ID/fingerprint replays; changed fingerprints conflict instead of repeating effects. */
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
  /** Create's committed opening message, even when its row is outside the returned history page. */
  firstMessage?: AgentJournalSubmission
  sessionId: string
  fence: number
  page: AgentSessionHistoryPage
  /** Submissions a crash boundary left `unknown`. No client reads it; kept for older peers. */
  unconfirmedClientMessageIds: string[]
  /** The host-owned id of the tab showing this chat, when it has one. Absent from older hosts. */
  tabId?: string
}

/** Only queue-if-active callers with queued-messages.v2 receive this draft arm; non-waiting states occur only on settled-draft replays. */
export type AgentSessionQueuedSendReceipt = {
  messageId: string
  position: number
  state: 'waiting' | 'dispatched' | 'returned' | 'withdrawn'
}

export type AgentSessionSendResult =
  | { clientMessageId: string; submission: AgentJournalSubmission }
  | { clientMessageId: string; queued: AgentSessionQueuedSendReceipt }

/** Undefined for queued replies; callers never sending delivery cannot receive that arm and read undefined as delivery-unknown. */
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
  resolvedModel?: string | null
  effortsKnown?: false
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  /** Transient display declaration; null is observed unknown, absence supplies no evidence. */
  declaredDefaultEffort?: string | null
  efforts: AgentSessionOptionChoice[]
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
  /** Whether the model runs Approve for me; absent is unknown, which neither offers nor launches it. */
  supportsAutoMode?: boolean
  /** Provider tier IDs beyond standard; capable clients replace Fast with one speed choice including default. Absence means unknown. */
  serviceTiers?: AgentSessionOptionChoice[]
}

export type AgentSessionFastModeState = 'off' | 'cooldown' | 'on'

export type AgentSessionFastModeSupport = {
  supported: boolean
  /** Provider-authored or host-normalized reason code; presentation may ignore unknown values. */
  reason?: string
}

/** Read the host catalog store outside session queues. unknown keeps the static seed; older hosts lack this additive read method. */
export type AgentSessionModelCatalogResult = {
  /** The host is running the listing this answer is waiting on (its first for the account, or
   *  the probe re-checking `unavailable`); a `waitForListing` read answers when it lands. Absent
   *  from a host that predates it; such a host sends it only with `unknown`. */
  listingInProgress?: true
  /** Why no chat can start under the account, as the host's probe last found it. Absent is
   *  unknown, which shows nothing; an older host never sends it. */
  unavailable?: AgentSessionUnavailable
} & (
  | { origin: 'unknown' }
  | {
      /** What produced the listing; any age is served, `fetchedAt` carries it. */
      origin: 'live-session' | 'probe'
      models: AgentSessionModelOption[]
      fastModeSupport?: AgentSessionFastModeSupport
      fetchedAt: number
      /** The listed default is the model a new chat here launches with: the agent's listing names
       *  its configured model and no workspace config can replace it. Absent from an older host. */
      listingNamesConfiguredModel?: boolean
      /** The named default holds in every workspace: the agent reads no project config for its
       *  model, so an answer naming no workspace serves any new chat. Absent from an older host. */
      defaultHoldsInEveryWorkspace?: true
      /** The models are this workspace's: its own config adds or removes some, so the answer serves
       *  no other workspace. Absent from an older host. */
      modelsDifferByWorkspace?: true
    }
)

/** Provider slash menu excludes terminal-only commands; skill names came from loaded skills rather than built-ins. */
export type AgentSessionSlashCommand = {
  name: string
  kind: 'command' | 'skill'
  /** Membership is authoritative, but this provider report did not classify the name. */
  kindUnspecified?: true
  /** Provider-authored row text; absent when the report carried names only. */
  description?: string
  /** Provider-authored argument sketch, e.g. `<issue-url>`. */
  argumentHint?: string
  /** The skill file the provider selects this skill by; two skills may share a name. */
  path?: string
}

/** Per-session provider commands; older hosts return method_not_found and clients retain their curated catalog. */
export type AgentSessionCommandsResult = {
  commands?: AgentSessionSlashCommand[]
  commandsPending?: boolean
}

export type AgentSessionContinuationContext =
  | { status: 'current'; capturedText?: string; transcriptPath?: string }
  | { status: 'superseded' }
