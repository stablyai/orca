import { useEffect } from 'react'
import { useAppStore } from '@/store'

// Hook config has no change notification, so refresh on mount/focus and while visible.
export const AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS = 30_000

export function useAgentHookInstallStatusRefresh(): void {
  const setAgentHookInstallStatuses = useAppStore((s) => s.setAgentHookInstallStatuses)

  useEffect(() => {
    let stopped = false
    let pollInFlight = false
    let timeoutId: number | null = null

    const clearPendingPoll = (): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const scheduleNextPoll = (): void => {
      clearPendingPoll()
      if (stopped || document.visibilityState !== 'visible') {
        return
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null
        void refresh()
      }, AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS)
    }

    const refresh = async (): Promise<void> => {
      const read = window.api?.agentHooks?.installStatuses
      if (!read || stopped || pollInFlight || document.visibilityState !== 'visible') {
        return
      }
      pollInFlight = true
      try {
        const statuses = await read()
        if (!stopped) {
          setAgentHookInstallStatuses(statuses)
        }
      } catch {
        // Why: a failed read is not evidence hooks are missing; keep the last
        // snapshot rather than degrading every dot to unverifiable on a blip.
      } finally {
        pollInFlight = false
        scheduleNextPoll()
      }
    }

    void refresh()

    const onFocusOrVisible = (): void => {
      if (document.visibilityState !== 'visible') {
        clearPendingPoll()
        return
      }
      void refresh()
    }
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)

    return () => {
      stopped = true
      clearPendingPoll()
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
    }
  }, [setAgentHookInstallStatuses])
}
