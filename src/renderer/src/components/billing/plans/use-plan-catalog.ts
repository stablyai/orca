import { useCallback, useEffect, useState } from 'react'
import type { OrcaPlanCatalogResult } from '../../../../../shared/orca-billing-plans'

// The last answer, so reopening the dialog shows the plans at once while they revalidate (main
// answers from its ETag-checked copy). A failed re-read never replaces a good one.
let lastResult: OrcaPlanCatalogResult | null = null

/** Test seam: forget the remembered catalog. */
export function resetPlanCatalogMemory(): void {
  lastResult = null
}

function keep(next: OrcaPlanCatalogResult): OrcaPlanCatalogResult {
  if (next.status !== 'ok' && lastResult?.status === 'ok') {
    return lastResult
  }
  lastResult = next
  return next
}

async function read(): Promise<OrcaPlanCatalogResult> {
  try {
    return await window.api.orcaProfiles.billingPlans()
  } catch (error) {
    return { status: 'failed', error: String(error) }
  }
}

/**
 * Billing's plan catalog while `enabled`: read when it turns on and on `refresh()`. Null until the
 * first answer of this session arrives (the dialog shows its skeleton meanwhile).
 */
export function usePlanCatalog(enabled: boolean): {
  result: OrcaPlanCatalogResult | null
  refresh: () => void
} {
  const [result, setResult] = useState<OrcaPlanCatalogResult | null>(lastResult)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let live = true
    void read().then((next) => {
      if (live) {
        setResult(keep(next))
      }
    })
    return () => {
      live = false
    }
  }, [enabled, generation])

  return { result: enabled ? result : null, refresh }
}
