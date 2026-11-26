import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { MobileRelayStatusDetail } from '../../../../shared/remote-runtime/relay/mobile-relay-status'
import type { MobileRelayMintFailure } from '../../../../shared/remote-runtime/relay/mobile-relay-mint-failure'

export function useMobileRelayStatus(): MobileRelayStatusDetail {
  const [relayStatus, setRelayStatus] = useState<MobileRelayStatusDetail>({ status: 'offline' })

  useEffect(() => {
    let receivedEvent = false
    let active = true
    const unsubscribe = window.api.mobile.onRelayStatusChanged((detail) => {
      receivedEvent = true
      if (active) {
        setRelayStatus(detail)
      }
    })
    void window.api.mobile
      .getRelayStatus()
      .then((detail) => {
        if (active && !receivedEvent) {
          setRelayStatus(detail)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return relayStatus
}

// Account, entitlement, clock and build problems persist across a relay restart.
const PERSISTENT_MINT_FAILURE_CODES: readonly string[] = [
  'relay_signed_out',
  'relay_not_entitled',
  'relay_clock_skew'
]

function mintFailureMayClearWhenRelayRecovers(failure: MobileRelayMintFailure): boolean {
  return (
    failure.stage !== 'provider_missing' &&
    failure.stage !== 'e2ee_missing' &&
    !PERSISTENT_MINT_FAILURE_CODES.includes(failure.code)
  )
}

/**
 * Retry once when the relay registers again under a mint failure, so a finished outage clears the notice.
 * Only 'registered' counts: main publishes 'standby' whenever demand drops, including right after a failed mint.
 */
export function useMobileRelayMintRecovery({
  failure,
  busy,
  onRecover
}: {
  failure: MobileRelayMintFailure | null
  busy: boolean
  onRecover: () => void
}): void {
  const { status } = useMobileRelayStatus()
  const previousStatusRef = useRef(status)
  const recover = useEffectEvent(() => {
    if (failure !== null && !busy && mintFailureMayClearWhenRelayRecovers(failure)) {
      onRecover()
    }
  })

  useEffect(() => {
    const wasRegistered = previousStatusRef.current === 'registered'
    previousStatusRef.current = status
    if (!wasRegistered && status === 'registered') {
      recover()
    }
  }, [status])
}
