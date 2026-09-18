// Which agent produced a journal row.
//
// One journal is the durable record of one agent SESSION, and a session may run
// subagents. Rows from both land in the same timeline, so every "what is this
// agent doing right now" reader needs to say which producer it means. This is
// the only place absence of the marker is interpreted.

import type { AgentJournalRenderItem } from './agent-session-journal-types'

/** Whether the session's own agent produced this row, rather than a subagent it
 *  spawned. Absence means root: the producer stamps every child row it writes, and
 *  rows written before the marker existed are root as far as any reader can tell.
 *  Takes a persisted journal row as readily as the item reduced from it — the
 *  session's recency clock asks this question before an item exists. */
export function isRootAgentJournalItem(
  row: Pick<AgentJournalRenderItem, 'producedBySubagent'> | undefined
): boolean {
  return row?.producedBySubagent !== true
}
