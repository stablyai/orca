import type { TuiAgent } from '../../../../../shared/tui-agent'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'

/** Main opens the chat where it opens any chat this host lists: a host-kept chat comes back. */
export function reopenChatTab(worktreeId: string, sessionId: string, agent: TuiAgent): () => void {
  return () =>
    void import('@/lib/structured-agent-session-launch-surface').then(
      ({ openStructuredAgentSessionProvisionalTab }) =>
        openStructuredAgentSessionProvisionalTab({
          worktreeId,
          executionHostId: LOCAL_EXECUTION_HOST_ID,
          sessionId,
          agent,
          activate: false
        })
    )
}
