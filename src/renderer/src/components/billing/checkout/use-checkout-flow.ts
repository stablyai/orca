import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult
} from '../../../../../shared/orca-billing'
import { billingCheckoutLink } from '../billing-link'
import { getBillingGeneration, recordBillingStatusIfCurrent } from '../billing-summary-store'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import {
  activeCloudSetupSessionId,
  startCloudSetupSession
} from '@/lib/orca-cloud/cloud-setup-session'
import {
  CHECKOUT_POLL_MS,
  CHECKOUT_SLOW_POLL_MS,
  CHECKOUT_SLOW_WATCH_MS,
  CHECKOUT_WATCH_MS,
  checkoutPollVerdict,
  nextPhaseAfterOpen,
  type CheckoutOrder,
  type CheckoutPhase
} from './checkout-flow'

/** How long the "paid" check shows before the Team page takes over. */
export const PAID_HANDOFF_MS = 2_200

export type CheckoutFlow = {
  phase: CheckoutPhase
  start: (order: CheckoutOrder) => void
  /** Opens a fresh Checkout session for the same order. */
  reopen: () => void
  /** Restarts the watch window after a timeout. */
  keepWaiting: () => void
  reset: () => void
  /** "Copy link" on the checkout button: mints this order's Checkout URL and starts the watch. */
  copyLink: (order: CheckoutOrder) => Promise<string | null>
  /** "Copy link" on Reopen: a fresh Checkout URL for the same order. */
  copyReopenLink: () => Promise<string | null>
}

/** Joins an open setup session, so Checkout returns to its next step (T2 Compare plans). */
function checkoutArgsFor(order: CheckoutOrder): OrcaBillingCheckoutArgs {
  const setupSessionId = activeCloudSetupSessionId()
  return {
    plan: order.planId,
    interval: order.interval,
    seats: order.seats,
    ...(setupSessionId ? { setupSessionId } : {})
  }
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
      .billingOpenCheckout(checkoutArgsFor(order))
      .catch((error: unknown): OrcaBillingOpenResult => ({
        status: 'failed',
        error: String(error)
      }))
      .then(async (result): Promise<OrcaBillingOpenResult> => {
        if (result.status !== 'team-required') {
          return result
        }
        // O1: a plan always lands on a team. The browser makes or picks the team, then Checkout;
        // the setup session switches this profile to that team when it's there.
        const started = await startCloudSetupSession({ needs: ['team', 'plan'], chooseTeam: true })
        return started && 'sessionId' in started ? { status: 'opened' } : result
      })
      .then((result) => {
        if (id === runId.current) {
          setPhase(nextPhaseAfterOpen(order, result, Date.now()))
        }
      })
  }, [])

  // "Copy link": the same Checkout session, minted but not opened. Paying from the pasted link
  // (another browser profile) is watched exactly like an opened Checkout.
  const copyLink = useCallback(async (order: CheckoutOrder): Promise<string | null> => {
    const url = await billingCheckoutLink(checkoutArgsFor(order))
    if (url) {
      ++runId.current
      setPhase(nextPhaseAfterOpen(order, { status: 'opened' }, Date.now()))
    }
    return url
  }, [])

  const reset = useCallback(() => {
    runId.current++
    setPhase({ kind: 'idle' })
  }, [])

  // Watch while a payment can still land: fast while Stripe's page is open, slower after the
  // window ends or when the bank asked for a step (3-D Secure can finish minutes later).
  const watching =
    phase.kind === 'awaiting-payment' ||
    phase.kind === 'timed-out' ||
    phase.kind === 'needs-attention'
      ? phase
      : null

  useEffect(() => {
    if (!watching) {
      return
    }
    const order = watching.order
    let disposed = false
    let inFlight = false
    // A cancel link that lands mid-poll waits for that poll's answer instead of being dropped.
    let pendingUnpaid: (() => void) | undefined
    const check = (onUnpaid?: () => void): void => {
      if (onUnpaid) {
        pendingUnpaid = onUnpaid
      }
      if (inFlight) {
        return
      }
      inFlight = true
      const startedGeneration = getBillingGeneration()
      void window.api.orcaProfiles
        .billingStatus()
        .catch(() => null)
        .then((result) => {
          inFlight = false
          if (disposed || result?.status !== 'ok') {
            return
          }
          recordBillingStatusIfCurrent(startedGeneration, result)
          const unpaid = pendingUnpaid
          pendingUnpaid = undefined
          const verdict = checkoutPollVerdict(result.entitlement)
          if (verdict === 'paid') {
            setPhase({ kind: 'paid', order, seats: result.entitlement.seats })
          } else if (verdict === 'needs-attention' && watching.kind !== 'needs-attention') {
            setPhase({ kind: 'needs-attention', order })
          } else {
            unpaid?.()
          }
        })
    }
    const poll = (): void => check()
    // Paused while the window is hidden; becoming visible checks at once.
    const stopPolling = installWindowVisibilityInterval({
      run: poll,
      intervalMs: watching.kind === 'awaiting-payment' ? CHECKOUT_POLL_MS : CHECKOUT_SLOW_POLL_MS
    })
    const deadline =
      watching.kind === 'awaiting-payment'
        ? window.setTimeout(
            () => setPhase({ kind: 'timed-out', order }),
            Math.max(0, watching.since + CHECKOUT_WATCH_MS - Date.now())
          )
        : // Slow watch ends after a while; window focus and the return link still check.
          window.setTimeout(stopPolling, CHECKOUT_SLOW_WATCH_MS)
    window.addEventListener('focus', poll)
    const disposeReturn = window.api.orcaProfiles.onBillingReturn?.((event) => {
      // Any local app can open an orca:// link, so "canceled" is shown only after billing
      // confirms there is still no paid plan.
      check(
        event.kind === 'checkout-cancel' ? () => setPhase({ kind: 'canceled', order }) : undefined
      )
    })
    return () => {
      disposed = true
      stopPolling()
      window.clearTimeout(deadline)
      window.removeEventListener('focus', poll)
      disposeReturn?.()
    }
    // watchKey restarts the window after "Keep waiting".
  }, [watching, watchKey])

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

  const copyReopenLink = useCallback(
    (): Promise<string | null> => (order ? copyLink(order) : Promise.resolve(null)),
    [order, copyLink]
  )

  return { phase, start, reopen, keepWaiting, reset, copyLink, copyReopenLink }
}
