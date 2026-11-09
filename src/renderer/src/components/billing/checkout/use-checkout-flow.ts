import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaBillingOpenResult } from '../../../../../shared/orca-billing'
import {
  CHECKOUT_POLL_MS,
  CHECKOUT_WATCH_MS,
  checkoutPollVerdict,
  nextPhaseAfterOpen,
  type CheckoutOrder,
  type CheckoutPhase
} from './checkout-flow'

/** How long the "paid" check shows before the Team page takes over. */
export const PAID_HANDOFF_MS = 1_400

export type CheckoutFlow = {
  phase: CheckoutPhase
  start: (order: CheckoutOrder) => void
  /** Opens a fresh Checkout session for the same order. */
  reopen: () => void
  /** Restarts the watch window after a timeout. */
  keepWaiting: () => void
  reset: () => void
}

/**
 * Drives Checkout from the plans dialog. Polls the entitlement every 2 s for up to 3 min while
 * Stripe's page is open, and also reacts at once to the orca://billing/return link.
 */
export function useCheckoutFlow({ onPaid }: { onPaid: (seats: number) => void }): CheckoutFlow {
  const [phase, setPhase] = useState<CheckoutPhase>({ kind: 'idle' })
  const [watchKey, setWatchKey] = useState(0)
  const onPaidRef = useRef(onPaid)
  useEffect(() => {
    onPaidRef.current = onPaid
  }, [onPaid])
  const runId = useRef(0)

  const start = useCallback((order: CheckoutOrder) => {
    const id = ++runId.current
    setPhase({ kind: 'opening', order })
    void window.api.orcaProfiles
      .billingOpenCheckout({ plan: 'team', interval: order.interval, seats: order.seats })
      .catch((error: unknown): OrcaBillingOpenResult => ({
        status: 'failed',
        error: String(error)
      }))
      .then((result) => {
        if (id === runId.current) {
          setPhase(nextPhaseAfterOpen(order, result, Date.now()))
        }
      })
  }, [])

  const reset = useCallback(() => {
    runId.current++
    setPhase({ kind: 'idle' })
  }, [])

  const awaiting = phase.kind === 'awaiting-payment' ? phase : null

  // Poll while Stripe's page is open.
  useEffect(() => {
    if (!awaiting) {
      return
    }
    let disposed = false
    let inFlight = false
    const poll = (): void => {
      if (inFlight) {
        return
      }
      inFlight = true
      void window.api.orcaProfiles
        .billingStatus()
        .catch(() => null)
        .then((result) => {
          inFlight = false
          if (disposed || result?.status !== 'ok') {
            return
          }
          const verdict = checkoutPollVerdict(result.entitlement)
          if (verdict === 'paid') {
            setPhase({ kind: 'paid', order: awaiting.order, seats: result.entitlement.seats })
          } else if (verdict === 'needs-attention') {
            setPhase({ kind: 'needs-attention', order: awaiting.order })
          }
        })
    }
    const timer = window.setInterval(poll, CHECKOUT_POLL_MS)
    const deadline = window.setTimeout(
      () => setPhase({ kind: 'timed-out', order: awaiting.order }),
      Math.max(0, awaiting.since + CHECKOUT_WATCH_MS - Date.now())
    )
    window.addEventListener('focus', poll)
    const disposeReturn = window.api.orcaProfiles.onBillingReturn?.((event) => {
      if (event.kind === 'checkout-cancel') {
        setPhase({ kind: 'canceled', order: awaiting.order })
      } else {
        poll()
      }
    })
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.clearTimeout(deadline)
      window.removeEventListener('focus', poll)
      disposeReturn?.()
    }
    // watchKey restarts the window after "Keep waiting".
  }, [awaiting, watchKey])

  // Hand off to the Team page after the check has had a moment.
  const paidSeats = phase.kind === 'paid' ? phase.seats : null
  useEffect(() => {
    if (paidSeats === null) {
      return
    }
    const timer = window.setTimeout(() => onPaidRef.current(paidSeats), PAID_HANDOFF_MS)
    return () => window.clearTimeout(timer)
  }, [paidSeats])

  const order = phase.kind === 'idle' ? null : phase.order
  const reopen = useCallback(() => {
    if (order) {
      start(order)
    }
  }, [order, start])
  const keepWaiting = useCallback(() => {
    if (order) {
      setPhase({ kind: 'awaiting-payment', order, since: Date.now() })
      setWatchKey((key) => key + 1)
    }
  }, [order])

  return { phase, start, reopen, keepWaiting, reset }
}
