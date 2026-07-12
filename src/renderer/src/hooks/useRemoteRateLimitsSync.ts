import { useEffect } from 'react'
import { useAppStore } from '../store'
import { callRuntimeRpc } from '../runtime/runtime-rpc-client'
import {
  applyProviderAccountsRateLimits,
  watchProviderAccounts,
  type ProviderAccountsSnapshot
} from '../runtime/runtime-provider-accounts-client'

/** How often to force-refresh remote usage while a runtime env is focused. */
const REMOTE_RATE_LIMIT_REFRESH_MS = 60_000
const REMOTE_LIST_TIMEOUT_MS = 60_000

async function forcePullRemoteRateLimits(environmentId: string): Promise<void> {
  try {
    // Why: headless orca-remote does not get desktop window-focus poll triggers
    // the same way; accounts.list forces RateLimitService.refresh on the server
    // so Session/Weekly bars stay current without opening the Codex popover.
    const snapshot = await callRuntimeRpc<ProviderAccountsSnapshot>(
      { kind: 'environment', environmentId },
      'accounts.list',
      null,
      { timeoutMs: REMOTE_LIST_TIMEOUT_MS }
    )
    if (snapshot?.rateLimits) {
      useAppStore.getState().setRateLimitsFromPush(snapshot.rateLimits)
    }
  } catch (error) {
    console.error('Remote rate-limit sync failed:', error)
  }
}

/**
 * While a remote runtime (e.g. LXC1) is the active environment, keep desktop
 * Codex/Claude usage bars mirrored from the server without requiring a click
 * on the status-bar popover.
 */
export function useRemoteRateLimitsSync(): void {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId?.trim() || null)

  useEffect(() => {
    if (!environmentId) {
      return
    }

    void forcePullRemoteRateLimits(environmentId)

    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId: environmentId },
      {
        onSnapshot: (snapshot) => {
          applyProviderAccountsRateLimits(snapshot)
        },
        onError: (error) => {
          console.error('Remote accounts subscribe (rate limits) failed:', error)
        }
      }
    )

    const intervalId = window.setInterval(() => {
      void forcePullRemoteRateLimits(environmentId)
    }, REMOTE_RATE_LIMIT_REFRESH_MS)

    const onFocus = (): void => {
      void forcePullRemoteRateLimits(environmentId)
    }
    window.addEventListener('focus', onFocus)

    return () => {
      watcher.close()
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [environmentId])
}
