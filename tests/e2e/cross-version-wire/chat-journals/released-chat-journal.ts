import type { AgentJournalSnapshot } from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../../../src/main/native-chat/agent-session-journal/journal-sql-store.ts'
import type { TestJournalOptions } from '../../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { queueReleasedCards } from './released-chat-queue'

/** A queued card as a release lists it, withdrawn ones included. */
export type ReleasedCard = { messageId: string; position: number; state?: string }
/** A shipped build's journal: its reads and stop marks answer synchronously. */
export type ReleasedJournal = Pick<
  AgentSessionJournal,
  | 'appendSubmission'
  | 'resolveDispatch'
  | 'appendItem'
  | 'appendStopEvent'
  | 'appendLifecycleBatch'
  | 'appendQueueResume'
  | 'appendTombstone'
> & {
  queuedMessages: Parameters<typeof queueReleasedCards>[0] & {
    list: () => ReleasedCard[] | Promise<ReleasedCard[]>
  }
  stopMarks: { beginSettle: (userStop: boolean) => unknown; settled: (settle: unknown) => void }
  replaceEpochItems: (reason: string, fence: number, items: readonly unknown[]) => Promise<unknown>
  /** Only releases that held the chat in memory; later ones read it back from SQL. */
  snapshot: () => AgentJournalSnapshot
}
export type ReleasedOpener = {
  open: (options: TestJournalOptions) => Promise<ReleasedJournal>
  closeAll: () => Promise<void>
}
/** A chat as a release reads it back: its items and sends, and its queued cards. */
export type ReleasedChat = { snapshot: AgentJournalSnapshot; cards: ReleasedCard[] }
/** A release's opener, with its own read of a chat it opened. */
export type ReleasedReader = ReleasedOpener & {
  read: (journal: ReleasedJournal) => Promise<ReleasedChat>
}
