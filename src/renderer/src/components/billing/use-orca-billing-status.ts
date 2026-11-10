import { useCallback, useEffect } from 'react'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { refreshBillingStatus, useBillingState, watchBillingStatus } from './billing-summary-store'

type BillingStatusState = {
  /** True until the first answer for this account arrives, and while a read runs. */
  loading: boolean
  result: OrcaBillingStatusResult | null
}

/**
 * The shared billing status while `enabled`: read on mount, again on `refresh()`, and whenever the
 * window regains focus (the user comes back from Checkout or the Portal in their browser). A failed
 * re-read keeps the last good answer. A team or account switch drops the previous team's status and
 * reads the new one; an answer that started before the switch is never shown or recorded.
 */
export function useOrcaBillingStatus(
  enabled: boolean
): BillingStatusState & { refresh: () => void } {
  const snapshot = useBillingState()
  const accountKey = useOrcaAccountKey()
  // Billing just changed in-app (or the user asked): a read that started earlier may be stale.
  const refresh = useCallback(() => void refreshBillingStatus({ supersede: true }), [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const release = watchBillingStatus()
    const load = (): void => void refreshBillingStatus()
    load()
    window.addEventListener('focus', load)
    return () => {
      release()
      window.removeEventListener('focus', load)
    }
  }, [enabled, accountKey])

  if (!enabled) {
    return { loading: false, result: null, refresh }
  }
  return {
    // No answer yet means one is on its way (the read starts after the first paint).
    loading: snapshot.loading || snapshot.result === null,
    result: snapshot.result,
    refresh
  }
}
