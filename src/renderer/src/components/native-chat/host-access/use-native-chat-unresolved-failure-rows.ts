import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionUnresolvedFailureRows } from '../../../../../shared/agent-session/failures/agent-session-visible-failures'
import { rowsBesideStreamedText } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

/** Ids of the failure rows no later turn resolved. */
export function useNativeChatUnresolvedFailureRows(
  journalItems: readonly AgentJournalRenderItem[]
): ReadonlySet<string> {
  // Failures read no reply text, so a streamed reply's revisions reuse the last scan.
  const failureRows = rowsBesideStreamedText(journalItems)
  // Keyed by its ids so a streamed reply leaves the set, and the rows reading it, alone.
  const unresolvedKey = useMemo(
    // Sent messages too: a refused one's line can offer the fix.
    () => agentSessionUnresolvedFailureRows(failureRows, { sentMessages: true }).join('\n'),
    [failureRows]
  )
  return useMemo(() => new Set(unresolvedKey.split('\n')), [unresolvedKey])
}
