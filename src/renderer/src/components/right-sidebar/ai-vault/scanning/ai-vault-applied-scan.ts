import { useCallback, useRef, useState } from 'react'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { reuseAiVaultListResult } from '../session-list/ai-vault-session-identity'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

// Keep the result paired with the request that produced it through deferred publication.
export type AiVaultAppliedScan = {
  result: AiVaultListResult
  limit: AiVaultSessionLimit
  scopeKey: string
  /** Workspace and Project rows hold only that scope, so they never stand in for another one. */
  scopeOnly: boolean
  /** The scope's last list, shown until its rescan answers. */
  stale?: true
}

export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (applied: AiVaultAppliedScan, onApplied?: (result: AiVaultListResult) => void) => void
} {
  const [scan, setScan] = useState<AiVaultAppliedScan | null>(null)
  const acceptedScanRef = useRef<AiVaultAppliedScan | null>(null)
  // Preserve identity on unchanged republication so React still bails out.
  const applyScan = useCallback(
    (applied: AiVaultAppliedScan, onApplied?: (result: AiVaultListResult) => void) => {
      const previous = acceptedScanRef.current
      const result = reuseAiVaultListResult(previous?.result ?? null, applied.result)
      const next =
        previous !== null &&
        previous.result === result &&
        previous.limit === applied.limit &&
        previous.scopeKey === applied.scopeKey &&
        previous.stale === applied.stale
          ? previous
          : { ...applied, result }
      acceptedScanRef.current = next
      setScan(next)
      onApplied?.(result)
    },
    []
  )
  return { scan, applyScan }
}
