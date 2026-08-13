import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  watchProviderAccounts,
  type ProviderAccountsWatcher
} from '@/runtime/runtime-provider-accounts-client'

const RESUBSCRIBE_MIN_DELAY_MS = 5_000
const RESUBSCRIBE_MAX_DELAY_MS = 60_000

/**
 * Mirrors the active Remote Orca Server's RateLimitState into the store so
 * usage surfaces show the account owner's usage, not this desktop's (#7973).
 *
 * accounts.subscribe pushes a fresh AccountsSnapshot whenever the server's
 * RateLimitService state changes — its poll, forced refreshes, account
 * switches, and live statusline posts from running sessions — so the bars
 * track remote work in near-real-time. Mount once at App level.
 */
export function useRemoteAccountUsageSync(): void {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId?.trim() || null)
  const setRemoteRateLimits = useAppStore((s) => s.setRemoteRateLimits)
  const clearRemoteRateLimits = useAppStore((s) => s.clearRemoteRateLimits)

  useEffect(() => {
    clearRemoteRateLimits()
    if (!environmentId) {
      return
    }

    let disposed = false
    let watcher: ProviderAccountsWatcher | null = null
    let retryTimer: number | null = null
    let retryDelayMs = RESUBSCRIBE_MIN_DELAY_MS

    // Why: transport cutovers replay the subscription without a close, so this
    // only fires for real stream ends (serve shutdown, auth loss). Backoff keeps
    // an unreachable host at one dial per minute instead of a tight loop.
    const scheduleResubscribe = (): void => {
      if (disposed || retryTimer !== null) {
        return
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        connect()
      }, retryDelayMs)
      retryDelayMs = Math.min(retryDelayMs * 2, RESUBSCRIBE_MAX_DELAY_MS)
    }

    const connect = (): void => {
      if (disposed) {
        return
      }
      watcher?.close()
      watcher = watchProviderAccounts(
        { activeRuntimeEnvironmentId: environmentId },
        {
          onSnapshot: (snapshot) => {
            if (disposed) {
              return
            }
            retryDelayMs = RESUBSCRIBE_MIN_DELAY_MS
            if (snapshot.rateLimits) {
              setRemoteRateLimits(environmentId, snapshot.rateLimits)
            }
          },
          onError: scheduleResubscribe,
          onClosed: scheduleResubscribe
        }
      )
    }

    connect()
    return () => {
      disposed = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      watcher?.close()
    }
  }, [clearRemoteRateLimits, environmentId, setRemoteRateLimits])
}
