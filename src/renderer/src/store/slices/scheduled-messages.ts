import type { StateCreator } from 'zustand'
import type {
  ScheduledMessage,
  ScheduledMessagesSnapshot
} from '../../../../shared/scheduled-message-types'
import type { AppState } from '../types'

export type ScheduledMessagesSlice = {
  scheduledMessages: ScheduledMessage[]
  /** Bumped by every pushed snapshot, so a late hydrate cannot restore the queue
   *  as it stood before the push. */
  scheduledMessagesRevision: number
  setScheduledMessagesSnapshot: (snapshot: ScheduledMessagesSnapshot) => void
  /** Apply a one-shot `get()` result, unless a push already landed. */
  hydrateScheduledMessagesSnapshot: (snapshot: ScheduledMessagesSnapshot, revision: number) => void
}

export const createScheduledMessagesSlice: StateCreator<
  AppState,
  [],
  [],
  ScheduledMessagesSlice
> = (set) => ({
  scheduledMessages: [],
  scheduledMessagesRevision: 0,
  setScheduledMessagesSnapshot: (snapshot) =>
    set((state) => ({
      scheduledMessages: snapshot.messages,
      scheduledMessagesRevision: (state.scheduledMessagesRevision ?? 0) + 1
    })),
  hydrateScheduledMessagesSnapshot: (snapshot, revision) =>
    set((state) =>
      (state.scheduledMessagesRevision ?? 0) === revision
        ? { scheduledMessages: snapshot.messages, scheduledMessagesRevision: revision + 1 }
        : {}
    )
})

const NO_MESSAGES: ScheduledMessage[] = []

export function selectScheduledMessagesForWorktree(
  state: Pick<ScheduledMessagesSlice, 'scheduledMessages'>,
  worktreeId: string
): ScheduledMessage[] {
  const messages = (state.scheduledMessages ?? []).filter(
    (message) => message.worktreeId === worktreeId
  )
  // Why a shared empty array: this runs per card on every store change, and a
  // fresh [] each time would defeat the sidebar's referential-equality checks.
  return messages.length === 0 ? NO_MESSAGES : messages
}

export function selectPendingScheduledCount(
  state: Pick<ScheduledMessagesSlice, 'scheduledMessages'>,
  worktreeId: string
): number {
  let count = 0
  for (const message of state.scheduledMessages ?? []) {
    if (message.worktreeId === worktreeId && message.status === 'pending') {
      count += 1
    }
  }
  return count
}

export function selectHasScheduledMessageProblem(
  state: Pick<ScheduledMessagesSlice, 'scheduledMessages'>,
  worktreeId: string
): boolean {
  return (state.scheduledMessages ?? []).some(
    (message) => message.worktreeId === worktreeId && message.status !== 'pending'
  )
}
