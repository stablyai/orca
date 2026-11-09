// The in-app half of Checkout. Payment itself happens on Stripe's hosted page in the system
// browser (Apple Pay, Link, password-manager autofill, 3-D Secure and a URL bar the user can
// verify; card data never enters Orca). This tracks the order, waits for the subscription to
// appear, and decides what the plans dialog shows meanwhile.
import type {
  OrcaBillingEntitlement,
  OrcaBillingInterval,
  OrcaBillingOpenResult
} from '../../../../../shared/orca-billing'

export type CheckoutOrder = { interval: OrcaBillingInterval; seats: number }

export type CheckoutPhase =
  | { kind: 'idle' }
  /** Asking billing for a Checkout session; the browser is about to open. */
  | { kind: 'opening'; order: CheckoutOrder }
  /** Stripe's page is open in the browser; polling for the subscription. */
  | { kind: 'awaiting-payment'; order: CheckoutOrder; since: number }
  /** Paid: a short confirmation before landing on the Team page. */
  | { kind: 'paid'; order: CheckoutOrder; seats: number }
  /** The browser came back from Stripe's cancel link. Nothing was charged. */
  | { kind: 'canceled'; order: CheckoutOrder }
  /** Stripe took the card but the first invoice needs action (3-D Secure, decline). */
  | { kind: 'needs-attention'; order: CheckoutOrder }
  /** No payment arrived within the watch window; the user can keep waiting or reopen. */
  | { kind: 'timed-out'; order: CheckoutOrder }
  /** Billing refused to open Checkout; `copy` explains why. */
  | { kind: 'open-failed'; order: CheckoutOrder; result: OrcaBillingOpenResult }

/** Poll cadence and window while Stripe's page is open (design review M3). */
export const CHECKOUT_POLL_MS = 2_000
export const CHECKOUT_WATCH_MS = 3 * 60_000
/** After the window, or while the bank wants a step: keep listening, gently. */
export const CHECKOUT_SLOW_POLL_MS = 10_000

export type CheckoutPollVerdict = 'paid' | 'needs-attention' | 'waiting'

/** Reads one entitlement poll while awaiting payment. */
export function checkoutPollVerdict(entitlement: OrcaBillingEntitlement): CheckoutPollVerdict {
  if (entitlement.plan === null) {
    return 'waiting'
  }
  if (entitlement.status === 'active' || entitlement.status === 'trialing') {
    return 'paid'
  }
  // A subscription exists but its first invoice is unpaid (3-D Secure abandoned, card declined).
  if (entitlement.status === 'incomplete' || entitlement.status === 'past_due') {
    return 'needs-attention'
  }
  return 'waiting'
}

export function nextPhaseAfterOpen(
  order: CheckoutOrder,
  result: OrcaBillingOpenResult,
  now: number
): CheckoutPhase {
  if (result.status === 'opened') {
    return { kind: 'awaiting-payment', order, since: now }
  }
  return { kind: 'open-failed', order, result }
}

export function isCheckoutActive(phase: CheckoutPhase): boolean {
  return phase.kind !== 'idle' && phase.kind !== 'open-failed'
}
