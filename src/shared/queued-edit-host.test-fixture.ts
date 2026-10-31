import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageEditHoldResult,
  AgentSessionQueuedMessageUpdateResult
} from './agent-session-wire'
import type { QueuedMessageEdit } from './queued-message-edit'

type LeaseKey = { callerKey: string; editId: string }
type Update = QueuedMessageEdit & { messageId: string; expectedBodyFingerprint: string }
type DecisionRow = Pick<AgentSessionQueuedMessage, 'messageId' | 'position' | 'body' | 'state'> & {
  fingerprint: string
  holdReason: null
  returnedReason: null
  returnedRejection: null
  consumedAs: null
  queuedAt: null
}

export type QueuedEditHostFixtureModule = {
  queuedEditHost: (
    sessionId: string,
    message: AgentSessionQueuedMessage
  ) => {
    row: { body: AgentJournalMessageItem; fingerprint: string } | null
    update: (input: Update) => AgentSessionQueuedMessageUpdateResult
    acquire: (editId: string, expected: string) => AgentSessionQueuedMessageEditHoldResult
    depart: () => void
    leases: {
      heldIds: () => ReadonlySet<string>
      release: (key: LeaseKey, messageId: string) => void
      renew: (key: LeaseKey, messageId: string) => AgentSessionQueuedMessageEditHoldResult
      retire: (messageId: string) => void
      dispose: () => void
    }
  }
  queuedMessageUpdateDecision: (
    row: DecisionRow | null,
    sessionId: string,
    input: Update,
    readsImageCards?: boolean
  ) =>
    | AgentSessionQueuedMessageUpdateResult
    | {
        status: 'ready'
        body: AgentJournalMessageItem
        previous: AgentJournalMessageItem
        fingerprint: string
      }
}
