import type { AgentPaneThread } from '../threads/activity-thread-types'
import { activityInboxKind } from './activity-inbox'
import type { ActivityInboxEntry } from './activity-inbox-entries'

/**
 * The row you opened stays listed until you open another or leave Activity, even once it no longer needs you
 * (read, answered, or its agent working again), so it never vanishes under you. An agent row shows its pane's
 * current state; a bot item or access request shows as you opened it. A row kept past its source is marked
 * `gone`: an answered access request or a closed pane opens nothing.
 */
export function withOpenedEntry(
  entries: ActivityInboxEntry[],
  opened: ActivityInboxEntry | null,
  threads: readonly AgentPaneThread[]
): ActivityInboxEntry[] {
  if (!opened || entries.some((entry) => entry.key === opened.key)) {
    return entries
  }
  if (opened.kind !== 'agent') {
    return [...entries, { ...opened, gone: true }]
  }
  const thread = threads.find((candidate) => candidate.paneKey === opened.thread.paneKey)
  if (!thread) {
    return [...entries, { ...opened, gone: true }]
  }
  return [
    ...entries,
    { ...opened, thread, at: thread.latestTimestamp, ask: activityInboxKind(thread) === 'ask' }
  ]
}
