import type { AgentSessionCurrentRequestsMarker } from '../../requests/agent-session-current-requests-wire'
import type { AgentSessionCurrentRequestsState } from '../../requests/agent-session-current-requests'
import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'
import type {
  AgentSessionSlashCommand,
  AgentSessionHistoryPage,
  AgentSessionLatestTurn,
  AgentSessionPromptSuggestion,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from '../../agent-session-wire'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../requests/agent-session-queued-message-wire'
import type { AgentSessionBackgroundTaskState } from '../../background-tasks/agent-session-background-task-wire'
import type { AgentSessionRefusalReference } from '../../failures/agent-session-wire-refusals'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS
} from '../structured-agent-session-item-retention'
import type { StructuredAgentSubagentRoster } from '../structured-agent-session-subagent-roster'
import type { AgentSessionReceiptProvider } from '../../journal/agent-session-dispatch-limits'
import type { PendingProviderAttempts } from './agent-session-provider-received'

/** Sample hostNow/receivedAt to convert host turn starts into client-clock anchors when attaching mid-turn. */
export type StructuredAgentHostClock = {
  hostNow: number
  receivedAt: number
}

export type StructuredAgentSessionState = AgentSessionCurrentRequestsState & {
  epoch: string | null
  cursor: AgentJournalCursor | null
  fence: number | null
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  /** Own-row trim floor grows with paging so live batches cannot undo loaded history. */
  retainedOwnItemLimit: number
  /** All-agent memory ceiling grows with paging too. */
  retainedItemCap: number
  hasOlder: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The failed read's own text, for logs; a surface words `readRefusal` instead. */
  error?: string
  /** The refusal the failed read met, when the host sent one; cleared with `error`. */
  readRefusal?: AgentSessionRefusalReference
  backgroundTasks?: AgentSessionBackgroundTaskState | null
  /** Host-held drafts. Absent = no claim yet (older host); `[]`/null = empty. */
  queuedMessages?: AgentSessionQueuedMessage[] | null
  /** The queue's pause, published with the list; null when it sends on its own. */
  queuePause?: AgentSessionQueuePause | null
  /** Published with the list: the card the queue sends next once nothing runs, else null. */
  nextQueuedMessageId?: string | null
  commands?: AgentSessionSlashCommand[] | null
  activity?: AgentSessionTurnActivity | null
  /** Off the journal, so history pages and snapshots keep it; only a batch sets it. */
  promptSuggestion?: AgentSessionPromptSuggestion | null
  /** Absent until a frame from a host that stamps `hostNow` has been applied. */
  hostClock?: StructuredAgentHostClock
  /** Retain received roster entries by agent ID beyond the item window; absent until a page arrives. */
  subagentRoster?: StructuredAgentSubagentRoster
  /** Whole-journal turn state; older hosts omit it and require loaded-item fallback. */
  latestTurn?: AgentSessionLatestTurn | null
  /** Host-actionable prompts; older hosts treat every pending item as waiting. */
  actionablePromptIds?: string[]
  /** Host main-agent work state; older hosts derive from items/submissions. */
  working?: boolean
  /** Bump when a live turn revision falls outside the window so whole-journal turn readers refresh. */
  unloadedTurnRevisions?: number
  providerReceived?: ReadonlyMap<string, number>
  pendingProviderAttempts?: PendingProviderAttempts
}

export type StructuredAgentSessionAction =
  | { type: 'loading' }
  | { type: 'trim-history' }
  | { type: 'clear-provider-received' }
  | { type: 'requests-marker'; marker: AgentSessionCurrentRequestsMarker }
  | {
      type: 'requests-complete'
      marker: AgentSessionCurrentRequestsMarker
      items: AgentJournalRenderItem[]
    }
  | { type: 'error'; message: string; refusal?: AgentSessionRefusalReference }
  /** First subscription frame restates the roster even on cursor resume; an old host omitting it has no running children. */
  | {
      type: 'event'
      event: AgentSessionSubscribeEvent
      opensSubscription?: boolean
      receiptProvider?: AgentSessionReceiptProvider
    }
  | { type: 'history-page'; page: AgentSessionHistoryPage }
  | {
      type: 'older-page'
      requestedCursor: AgentJournalCursor
      page: AgentSessionHistoryPage
    }

export const EMPTY_STRUCTURED_AGENT_SESSION: StructuredAgentSessionState = {
  epoch: null,
  cursor: null,
  fence: null,
  items: [],
  submissions: [],
  retainedOwnItemLimit: MAX_RETAINED_OWN_ITEMS,
  retainedItemCap: MAX_RETAINED_ITEMS,
  hasOlder: false,
  status: 'idle'
}
