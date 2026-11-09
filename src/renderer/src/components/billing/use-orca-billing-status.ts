import { useCallback, useEffect, useState } from 'react'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { recordBillingStatus } from './billing-summary-store'

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
 * focus (the user comes back from Checkout or the Portal in their browser).
 */
export function useOrcaBillingStatus(
  enabled: boolean
): BillingStatusState & { refresh: () => void } {
  const [state, setState] = useState<BillingStatusState>({ loading: enabled, result: null })
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    let latest = 0
    const load = (): void => {
      const request = ++latest
      setState((previous) => ({ ...previous, loading: true }))
      void readBillingStatus().then((result) => {
        // A newer request, or unmounting, supersedes this one.
        if (!disposed && request === latest) {
          recordBillingStatus(result)
          setState({ loading: false, result })
        }
      })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      disposed = true
      window.removeEventListener('focus', load)
    }
  }, [enabled, reloadKey])

  return { ...state, refresh }
}
