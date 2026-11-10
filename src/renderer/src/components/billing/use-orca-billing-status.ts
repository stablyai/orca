import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import {
  getBillingGeneration,
  getLastBillingStatus,
  recordBillingStatusIfCurrent
} from './billing-summary-store'

type BillingStatusState = {
  loading: boolean
  result: OrcaBillingStatusResult | null
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
 * Reads the billing status while `enabled`, again on `refresh()`, and whenever the window regains
 * focus (the user comes back from Checkout or the Portal in their browser). A team or account
 * switch drops the previous team's status and reads the new one; an answer that started before
 * the switch is never shown or recorded.
 */
export function useOrcaBillingStatus(
  enabled: boolean
): BillingStatusState & { refresh: () => void } {
  const [state, setState] = useState<BillingStatusState>(() => ({
    loading: enabled,
    result: enabled ? getLastBillingStatus() : null
  }))
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])
  const accountKey = useOrcaAccountKey()
  const loadedAccount = useRef(accountKey)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    let latest = 0
    const switched = loadedAccount.current !== accountKey
    loadedAccount.current = accountKey
    const load = (): void => {
      const request = ++latest
      const startedGeneration = getBillingGeneration()
      // The previous team's plan must not stay on screen while the new team's loads.
      setState((previous) =>
        switched && request === 1 ? { loading: true, result: null } : { ...previous, loading: true }
      )
      void readBillingStatus().then((result) => {
        // A newer request, or unmounting, supersedes this one.
        if (disposed || request !== latest) {
          return
        }
        // The account or team changed while this was in flight: the answer is for the old one.
        if (getBillingGeneration() !== startedGeneration) {
          load()
          return
        }
        recordBillingStatusIfCurrent(startedGeneration, result)
        setState({ loading: false, result })
      })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      disposed = true
      window.removeEventListener('focus', load)
    }
  }, [enabled, reloadKey, accountKey])

  return { ...state, refresh }
}
