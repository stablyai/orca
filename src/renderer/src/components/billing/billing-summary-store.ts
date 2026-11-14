// The one billing-status cache. Settings, the plans and Team pages, the build sheet, the Run-on
// picker and the account menu all read it, so they always agree and a read by one serves the others.
// It keeps the last good answer: a failed read (offline for a moment when the window regains focus)
// never replaces it. Answers are scoped to the account and team that asked for them.
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { getOrcaAccountKey } from '@/hooks/use-orca-account-key'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { isActivePlan } from './plan-billing-format'

export type BillingSummary = {
  /** null until the first read answers (or when billing is off for this build/account). */
  subscribed: boolean | null
  canManageBilling: boolean
  /** "Team" when subscribed; null otherwise. */
  planLabel: string | null
}

export type BillingStoreState = {
  /** Last answer for the current account and team; 'failed' only when nothing good was read yet. */
  result: OrcaBillingStatusResult | null
  /** A read for the current account is running. */
  loading: boolean
  /** When `result` was last confirmed by the service; 0 when stale or never. */
  fetchedAt: number
}

const EMPTY: BillingStoreState = { result: null, loading: false, fetchedAt: 0 }
const SUMMARY_MIN_REFRESH_MS = 60_000

let state: BillingStoreState = EMPTY
/** Account the current `result` belongs to. */
let stateAccount: string | null = null
/** Bumped on every account/team switch; answers that started before it are dropped. */
let generation = 0
/** Only the newest read may write; an older one that answers late is dropped. */
let latestRead = 0
let inFlight: { generation: number; account: string; promise: Promise<void> } | null = null
/** Mounted views that want billing kept current (re-read after a switch drops a read). */
let watchers = 0
const listeners = new Set<() => void>()

function currentAccount(): string {
  return getOrcaAccountKey(useAppStore.getState().orcaProfileAuthStatus)
}

function setState(next: BillingStoreState): void {
  if (
    next.result === state.result &&
    next.loading === state.loading &&
    next.fetchedAt === state.fetchedAt
  ) {
    return
  }
  state = next
  for (const listener of listeners) {
    listener()
  }
}

function readBillingStatus(): Promise<OrcaBillingStatusResult> {
  return window.api.orcaProfiles
    .billingStatus()
    .catch((error: unknown): OrcaBillingStatusResult => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }))
}

/**
 * Merges an answer into the cache: a failure keeps the last good result for the same account
 * (a brief offline moment must not blank the section); anything else replaces it.
 */
export function mergeBillingResult(
  previous: OrcaBillingStatusResult | null,
  next: OrcaBillingStatusResult
): OrcaBillingStatusResult {
  return next.status === 'failed' && previous?.status === 'ok' ? previous : next
}

export function recordBillingStatus(result: OrcaBillingStatusResult): void {
  const account = currentAccount()
  const previous = stateAccount === account ? state.result : null
  const merged = mergeBillingResult(previous, result)
  stateAccount = account
  setState({
    result: merged,
    loading: inFlight !== null,
    // A result kept through a failure counts as stale, so the next look reads again.
    fetchedAt: merged === result ? Date.now() : 0
  })
}

/** The latest good status for the current account, to seed views that open later. */
export function getLastBillingStatus(): OrcaBillingStatusResult | null {
  return stateAccount === currentAccount() && state.result?.status === 'ok' ? state.result : null
}

export function getBillingGeneration(): number {
  return generation
}

/** Records a status read that started in `startedGeneration`; reads from a previous account are dropped. */
export function recordBillingStatusIfCurrent(
  startedGeneration: number,
  result: OrcaBillingStatusResult
): void {
  if (startedGeneration === generation) {
    recordBillingStatus(result)
  }
}

/** Forget the previous account's plan at once (sign-out, account or team switch). */
export function resetBillingSummary(): void {
  generation++
  latestRead++
  inFlight = null
  stateAccount = null
  setState(EMPTY)
  if (watchers > 0) {
    // Views still on screen read the new account's billing at once.
    void refreshBillingStatus()
  }
}

/** Marks the cached answer stale (billing changed elsewhere) so the next read doesn't trust it. */
export function markBillingStale(): void {
  setState({ ...state, fetchedAt: 0 })
}

export function hasBillingWatchers(): boolean {
  return watchers > 0
}

/** A mounted view that wants billing current; returns its release. */
export function watchBillingStatus(): () => void {
  watchers++
  let released = false
  return () => {
    if (!released) {
      released = true
      watchers--
    }
  }
}

/** The running read for the current account, if any (callers wait on it). */
export function getBillingReadInFlight(): Promise<void> | null {
  return inFlight?.promise ?? null
}

/**
 * Reads billing status. Joins a running read for the same account unless `supersede` (billing just
 * changed in-app, so a read that started earlier may be stale). With `maxAgeMs`, a cached answer
 * younger than that is trusted and nothing is read.
 */
export function refreshBillingStatus({
  supersede = false,
  maxAgeMs = 0
}: { supersede?: boolean; maxAgeMs?: number } = {}): Promise<void> {
  const account = currentAccount()
  if (
    !supersede &&
    inFlight &&
    inFlight.generation === generation &&
    inFlight.account === account
  ) {
    return inFlight.promise
  }
  if (
    maxAgeMs > 0 &&
    stateAccount === account &&
    state.result &&
    Date.now() - state.fetchedAt < maxAgeMs
  ) {
    return Promise.resolve()
  }
  if (stateAccount !== account) {
    // Another account's answer must not stay on screen while this one's loads.
    stateAccount = account
    setState(EMPTY)
  }
  const startedGeneration = generation
  const mine = ++latestRead
  const promise = readBillingStatus().then((result): Promise<void> | void => {
    if (mine !== latestRead) {
      // Superseded by a newer read or a reset; that one writes.
      return
    }
    inFlight = null
    if (startedGeneration !== generation || account !== currentAccount()) {
      // The account or team changed mid-read: the answer is for the old one. Read again for
      // whoever is still looking.
      if (watchers > 0) {
        return refreshBillingStatus()
      }
      setState({ ...state, loading: false })
      return
    }
    recordBillingStatus(result)
  })
  inFlight = { generation: startedGeneration, account, promise }
  setState({ ...state, loading: true })
  return promise
}

/** Re-reads billing status at most once a minute unless `force` (account or team switched). */
export function refreshBillingSummary(force = false): Promise<void> {
  return refreshBillingStatus(force ? {} : { maxAgeMs: SUMMARY_MIN_REFRESH_MS })
}

export function getBillingState(): BillingStoreState {
  return state
}

export function subscribeBillingState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBillingState(): BillingStoreState {
  return useSyncExternalStore(subscribeBillingState, getBillingState)
}

const UNKNOWN_SUMMARY: BillingSummary = {
  subscribed: null,
  canManageBilling: false,
  planLabel: null
}
let summaryFor: OrcaBillingStatusResult | null = null
let summary: BillingSummary = UNKNOWN_SUMMARY

export function getBillingSummary(): BillingSummary {
  const result = state.result
  if (result === summaryFor) {
    return summary
  }
  summaryFor = result
  const next: BillingSummary =
    result?.status === 'ok'
      ? {
          subscribed: isActivePlan(result.entitlement),
          canManageBilling: result.entitlement.canManageBilling,
          planLabel: isActivePlan(result.entitlement) ? result.entitlement.planLabel : null
        }
      : UNKNOWN_SUMMARY
  // Keep the same object when nothing visible changed, so subscribers don't re-render.
  if (
    next.subscribed !== summary.subscribed ||
    next.canManageBilling !== summary.canManageBilling ||
    next.planLabel !== summary.planLabel
  ) {
    summary = next
  }
  return summary
}

export const subscribeBillingSummary = subscribeBillingState

export function useBillingSummary(): BillingSummary {
  return useSyncExternalStore(subscribeBillingState, getBillingSummary)
}
