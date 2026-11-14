import type { AgentJournalSnapshot } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'
import type { TestJournalOptions } from '../../../src/main/native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
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
  queuedMessages: Parameters<typeof queueReleasedCards>[0] & { list: () => ReleasedCard[] }
  stopMarks: { beginSettle: (userStop: boolean) => unknown; settled: (settle: unknown) => void }
  replaceEpochItems: (reason: string, fence: number, items: readonly unknown[]) => Promise<unknown>
  snapshot: () => AgentJournalSnapshot
}
export type ReleasedOpener = {
  open: (options: TestJournalOptions) => Promise<ReleasedJournal>
  closeAll: () => Promise<void>
}
