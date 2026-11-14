import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { getAgentSessionIdsKey } from './ai-vault-agent-session-refresh-key'
import { claimAiVaultForcedRescan, aiVaultForcedRescanDelay } from './ai-vault-forced-rescan-budget'

/** In-app launches never blur; rescan on new provider session IDs, avoiding frequent state transitions. */
export function useAiVaultNewSessionRescan(
  refresh: (args: { background: true; force: true }) => Promise<void>,
  terminalOnly = false
): void {
  // The budget is shared across remounts so session creation cannot amplify full scans; a throttled
  // rescan waits for budget rather than leaving new sessions invisible.
  const forcedRescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestForcedRescan = useCallback(() => {
    function attempt(): void {
      if (claimAiVaultForcedRescan()) {
        void refresh({ background: true, force: true })
        return
      }
      if (forcedRescanTimerRef.current !== null) {
        return
      }
      forcedRescanTimerRef.current = setTimeout(() => {
        forcedRescanTimerRef.current = null
        attempt()
      }, aiVaultForcedRescanDelay())
    }
    attempt()
  }, [refresh])

  useEffect(
    () => () => {
      if (forcedRescanTimerRef.current !== null) {
        clearTimeout(forcedRescanTimerRef.current)
        forcedRescanTimerRef.current = null
      }
    },
    []
  )

  const agentSessionIdsKey = useAppStore((s) =>
    getAgentSessionIdsKey(s.agentStatusByPaneKey, terminalOnly)
  )
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
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
  }, [agentSessionIdsKey, requestForcedRescan])
}
