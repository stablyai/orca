import { useEffect, useRef, type RefObject } from 'react'
import {
  REVIEW_REFRESH_COOLDOWN_MS,
  subscribePRAutoRefreshCadence
} from '../../../../../../shared/review-refresh-policy'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-activity/window-visibility-timeout-poller'
import { getPRRefreshOwnerRuntimeEnvironmentId } from '@/store/github/repositories/repository-routing'
import { hostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import type { ChecksDetailPollingPolicy } from '../../../../../../shared/github/checks-detail-polling-policy'
import type { ChecksPanelPollingInput, ChecksPanelPollingState } from './use-checks-panel-polling'

export function useChecksDetailTimer({
  model,
  modelRef,
  policyRef,
  requestIdentity,
  fetchChecks,
  fetchGitLabDetails
}: {
  model: ChecksPanelPollingInput
  modelRef: RefObject<ChecksPanelPollingInput>
  policyRef: RefObject<ChecksDetailPollingPolicy>
  requestIdentity: string
  fetchChecks: ChecksPanelPollingState['fetchChecks']
  fetchGitLabDetails: ChecksPanelPollingState['fetchGitLabDetails']
}): void {
  const {
    activeGitLabReview,
    pr,
    prNumber,
    isPanelVisible,
    setChecks,
    setComments,
    pollIntervalRef,
    prevChecksRef
  } = model
  const refreshRef = useRef<(() => void) | null>(null)
  const forceNextFetchRef = useRef(false)
  const isGitLabReview = activeGitLabReview !== null
  const lastIdentityRef = useRef<string | null>(null)
  const lastAttemptAtRef = useRef(-Infinity)
  const nextAttemptAtRef = useRef(-Infinity)
  const inFlightRef = useRef<{ identity: string; token: symbol } | null>(null)
  // The first read after the panel opens (or its review changes) is the user looking; later polls are background (E9).
  const wakeNextReadRef = useRef(true)
  useEffect(() => {
    if (lastIdentityRef.current !== requestIdentity) {
      lastIdentityRef.current = requestIdentity
      lastAttemptAtRef.current = -Infinity
      nextAttemptAtRef.current = -Infinity
      forceNextFetchRef.current = false
      wakeNextReadRef.current = true
      policyRef.current.reset()
      pollIntervalRef.current = 60_000
      prevChecksRef.current = ''
      setChecks([])
      setComments([])
    }
    if (!isPanelVisible || (!isGitLabReview && !prNumber)) {
      wakeNextReadRef.current = true
      return
    }
    const policyDelay = (): number | null => {
      const current = modelRef.current
      // The host that reads these checks owns the cadence: a paired host's setting, else this app's.
      const cadence = hostPRAutoRefreshCadence(
        getPRRefreshOwnerRuntimeEnvironmentId({
          cacheKey: current.prCacheKey ?? '',
          executionHostId: current.repo?.executionHostId ?? null
        })
      )
      return policyRef.current.delayMs(
        current.activeGitLabReview?.state ?? current.pr?.state,
        current.activeGitLabReview?.status ?? current.pr?.checksStatus,
        current.pollIntervalRef.current,
        cadence
      )
    }
    const cleanup = installWindowVisibilityTimeoutPoller({
      run: async ({ trigger }) => {
        if (inFlightRef.current?.identity === requestIdentity) {
          return
        }
        const now = Date.now()
        const nextAttemptAt = nextAttemptAtRef.current
        if (
          now - lastAttemptAtRef.current < REVIEW_REFRESH_COOLDOWN_MS ||
          (Number.isFinite(nextAttemptAt)
            ? now < nextAttemptAt
            : nextAttemptAt === Infinity &&
              !forceNextFetchRef.current &&
              now - lastAttemptAtRef.current < 60_000)
        ) {
          return
        }
        const token = Symbol()
        inFlightRef.current = { identity: requestIdentity, token }
        const shown = wakeNextReadRef.current
        wakeNextReadRef.current = false
        lastAttemptAtRef.current = now
        nextAttemptAtRef.current = Infinity
        const force = forceNextFetchRef.current
        forceNextFetchRef.current = false
        // Only the timer's own tick is a background read the host may pace; the window coming
        // back, the panel opening and a changed aggregate state must read fresh.
        const background = trigger === 'timer' && !shown && !force
        try {
          await (isGitLabReview
            ? fetchGitLabDetails(shown ? {} : { background: true })
            : fetchChecks({
                force,
                ...(shown ? { wakeWslDistro: true } : {}),
                ...(background ? { background: true } : {})
              }))
        } finally {
          if (inFlightRef.current?.token === token) {
            inFlightRef.current = null
            if (lastIdentityRef.current === requestIdentity) {
              const delay = policyDelay()
              nextAttemptAtRef.current = delay === null ? Infinity : Date.now() + delay
              refreshRef.current?.()
            }
          }
        }
      },
      getDelayMs: () => {
        const delay = policyDelay()
        if (inFlightRef.current?.identity === requestIdentity) {
          return delay
        }
        if (delay === null) {
          return forceNextFetchRef.current
            ? Math.max(0, lastAttemptAtRef.current + REVIEW_REFRESH_COOLDOWN_MS - Date.now())
            : null
        }
        return Number.isFinite(nextAttemptAtRef.current)
          ? Math.max(0, nextAttemptAtRef.current - Date.now())
          : delay
      }
    })
    refreshRef.current = cleanup.refresh
    // A cadence change (this app's or the owning host's) re-plans a mounted panel at once: a timer
    // stopped under "off" starts again, and one armed for Default is disarmed.
    const unsubscribeCadence = subscribePRAutoRefreshCadence(() => {
      if (inFlightRef.current?.identity === requestIdentity) {
        return
      }
      const delay = policyDelay()
      if (Number.isFinite(lastAttemptAtRef.current)) {
        nextAttemptAtRef.current = delay === null ? Infinity : lastAttemptAtRef.current + delay
      }
      cleanup.replan()
    })
    return () => {
      refreshRef.current = null
      unsubscribeCadence()
      cleanup()
    }
  }, [
    requestIdentity,
    modelRef,
    policyRef,
    fetchChecks,
    fetchGitLabDetails,
    isPanelVisible,
    isGitLabReview,
    prNumber,
    pollIntervalRef,
    prevChecksRef,
    setChecks,
    setComments
  ])

  const aggregatePending = (activeGitLabReview?.status ?? pr?.checksStatus) === 'pending'
  const reviewState = activeGitLabReview?.state ?? pr?.state
  const previousPendingRef = useRef(aggregatePending)
  useEffect(() => {
    if (previousPendingRef.current !== aggregatePending) {
      previousPendingRef.current = aggregatePending
      forceNextFetchRef.current = true
      if (aggregatePending) {
        policyRef.current.reset()
      }
      if (nextAttemptAtRef.current === Infinity) {
        nextAttemptAtRef.current = lastAttemptAtRef.current + REVIEW_REFRESH_COOLDOWN_MS
      }
      refreshRef.current?.()
    }
  }, [aggregatePending, reviewState, policyRef])
}
