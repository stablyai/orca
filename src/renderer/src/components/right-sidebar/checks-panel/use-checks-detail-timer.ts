import { useEffect, useRef, type RefObject } from 'react'
import { REVIEW_REFRESH_COOLDOWN_MS } from '../../../../../shared/review-refresh-policy'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import type { ChecksDetailPollingPolicy } from './checks-detail-polling-policy'
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
  useEffect(() => {
    if (lastIdentityRef.current !== requestIdentity) {
      lastIdentityRef.current = requestIdentity
      lastAttemptAtRef.current = -Infinity
      nextAttemptAtRef.current = -Infinity
      forceNextFetchRef.current = false
      policyRef.current.reset()
      pollIntervalRef.current = 60_000
      prevChecksRef.current = ''
      setChecks([])
      setComments([])
    }
    if (!isPanelVisible || (!isGitLabReview && !prNumber)) {
      return
    }
    const policyDelay = (): number | null => {
      const current = modelRef.current
      return policyRef.current.delayMs(
        current.activeGitLabReview?.state ?? current.pr?.state,
        current.activeGitLabReview?.status ?? current.pr?.checksStatus,
        current.pollIntervalRef.current
      )
    }
    const cleanup = installWindowVisibilityTimeoutPoller({
      run: async () => {
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
        lastAttemptAtRef.current = now
        nextAttemptAtRef.current = Infinity
        const force = forceNextFetchRef.current
        forceNextFetchRef.current = false
        try {
          await (isGitLabReview ? fetchGitLabDetails() : fetchChecks({ force }))
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
    return () => {
      refreshRef.current = null
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
