import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  canSkipAgentHookInstallStatusConsumerSync,
  selectHasAgentHookInstallStatusConsumer
} from '@/components/sidebar/worktree-hook-observability'

// Hook config has no change notification; refresh only while a visible consumer needs it.
export const AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS = 30_000

export function useAgentHookInstallStatusRefresh(): void {
  const setAgentHookInstallStatuses = useAppStore((s) => s.setAgentHookInstallStatuses)

  useEffect(() => {
    let stopped = false
    let pollInFlight = false
    let timeoutId: number | null = null
    let hasConsumer = selectHasAgentHookInstallStatusConsumer(useAppStore.getState())

    const clearPendingPoll = (): void => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const scheduleNextPoll = (): void => {
      clearPendingPoll()
      if (stopped || !hasConsumer || document.visibilityState !== 'visible') {
        return
      }
      timeoutId = window.setTimeout(() => {
        timeoutId = null
        void refresh()
      }, AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS)
    }

    const refresh = async (): Promise<void> => {
      const read = window.api?.agentHooks?.installStatuses
      if (
        !read ||
        stopped ||
        !hasConsumer ||
        pollInFlight ||
        document.visibilityState !== 'visible'
      ) {
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

    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      // Snapshot/status/UI writes cannot change which execution-host consumers need polling.
      if (canSkipAgentHookInstallStatusConsumerSync(state, previousState)) {
        return
      }
      const nextHasConsumer = selectHasAgentHookInstallStatusConsumer(state)
      if (nextHasConsumer === hasConsumer) {
        return
      }
      hasConsumer = nextHasConsumer
      if (hasConsumer) {
        void refresh()
      } else {
        clearPendingPoll()
      }
    })
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
      unsubscribe()
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
    }
  }, [setAgentHookInstallStatuses])
}
