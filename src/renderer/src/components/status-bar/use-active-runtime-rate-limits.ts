import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import {
  hasRemoteProviderAccountOwner,
  refreshRemoteProviderAccountsSnapshot,
  watchProviderAccounts
} from '../../runtime/runtime-provider-accounts-client'

type RemoteRateLimits = {
  environmentId: string
  state: RateLimitState
}

export function useActiveRuntimeRateLimits(
  localRateLimits: RateLimitState,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): {
  rateLimits: RateLimitState
  remoteOwner: boolean
  refreshRemoteRateLimits: () => Promise<void>
} {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim() ?? ''
  const remoteOwner = hasRemoteProviderAccountOwner(settings)
  const ownerSettings = useMemo(
    () => ({ activeRuntimeEnvironmentId: environmentId || null }),
    [environmentId]
  )
  const [remoteRateLimits, setRemoteRateLimits] = useState<RemoteRateLimits | null>(null)

  useEffect(() => {
    if (!remoteOwner || !environmentId) {
      setRemoteRateLimits(null)
      return
    }
    // Why: never show the Mac's quota as if it belonged to a selected remote
    // host while the first remote snapshot is still crossing the runtime RPC.
    setRemoteRateLimits((current) => (current?.environmentId === environmentId ? current : null))
    const watcher = watchProviderAccounts(ownerSettings, {
      onSnapshot: (snapshot) => {
        if (snapshot.rateLimits) {
          setRemoteRateLimits({ environmentId, state: snapshot.rateLimits })
        }
      },
      onError: (error) => {
        console.error('Failed to watch remote provider usage:', error)
      }
    })
    return () => watcher.close()
  }, [environmentId, ownerSettings, remoteOwner])

  const rateLimits = useMemo(() => {
    if (!remoteOwner) {
      return localRateLimits
    }
    return remoteRateLimits?.environmentId === environmentId
      ? remoteRateLimits.state
      : createEmptyRateLimitState()
  }, [environmentId, localRateLimits, remoteOwner, remoteRateLimits])

  const refreshRemoteRateLimits = useCallback(async (): Promise<void> => {
    if (!remoteOwner || !environmentId) {
      return
    }
    const snapshot = await refreshRemoteProviderAccountsSnapshot(ownerSettings)
    if (snapshot.rateLimits) {
      setRemoteRateLimits({ environmentId, state: snapshot.rateLimits })
    }
  }, [environmentId, ownerSettings, remoteOwner])

  return { rateLimits, remoteOwner, refreshRemoteRateLimits }
}
