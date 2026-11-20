import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { getAgentSessionIdsKey } from './ai-vault/scanning/ai-vault-agent-session-refresh-key'
import { useAiVaultSessionHostRefreshEvents } from './ai-vault/scope/ai-vault-host-scope'

// Why split: keeps the session list hook under the line budget. Triggers only
// read screen state and call back into the list refresh, so they own no scan state.
export function useAiVaultSessionRefreshTriggers(args: {
  enabled: boolean
  error: string | null
  refresh: (refreshArgs?: { background?: boolean; force?: boolean }) => Promise<void>
  requestForcedRescan: () => void
}): void {
  const { enabled, error, refresh, requestForcedRescan } = args
  // Why: this panel can query the relay before it is ready — at startup, and again for the window
  // in which a reconnect leaves the session not-ready — and the query throws 'SSH relay is not
  // ready'. Nothing else here retries: the remaining triggers are mount, window refocus and a new
  // agent session id, so a user whose workspace is otherwise working sits on that error
  // indefinitely. The file explorer already recovers this way for the same reason
  // (use-file-explorer-tree-load-effects.ts); this panel simply never did.
  //
  // Gated on a prior error so a local workspace, or one that already listed fine, does not rescan
  // every time some other host connects.
  useAiVaultSessionHostRefreshEvents(error, refresh)

  // Sessions started inside Orca never blur the window, so refocus alone
  // can't surface them. Agent hooks already report provider sessions; re-scan
  // only when a session id we haven't seen appears — state transitions are
  // deliberately ignored, they fire constantly while agents work.
  const agentSessionIdsKey = useAppStore((s) => getAgentSessionIdsKey(s.agentStatusByPaneKey))
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const ids = agentSessionIdsKey === '' ? [] : agentSessionIdsKey.split('\n')
    // The mount refresh already covers sessions live at mount time.
    if (seenAgentSessionIdsRef.current === null) {
      seenAgentSessionIdsRef.current = new Set(ids)
      return
    }
    const seen = seenAgentSessionIdsRef.current
    const freshIds = ids.filter((id) => !seen.has(id))
    if (freshIds.length === 0) {
      return
    }
    for (const id of freshIds) {
      seen.add(id)
    }
    requestForcedRescan()
  }, [agentSessionIdsKey, enabled, requestForcedRescan])
}
